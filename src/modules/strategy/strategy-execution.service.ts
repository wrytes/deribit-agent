import { Injectable, Logger } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketDataService, OptionChainSummary } from '../market-data/market-data.service';
import { StrategyService } from './strategy.service';
import { StrategyStatus, StrategyType } from '@prisma/client';
import { OrderType } from '@wrytlabs/deribit-api-client';

/** Deribit minimum contract size for BTC options (1 contract = 1 BTC). */
const MIN_BTC_AMOUNT = 0.1;

interface LegOrder {
  instrument: string;
  side: 'buy' | 'sell';
  amount: number; // BTC
}

interface LegResult extends LegOrder {
  orderId?: string;
  avgPrice?: number;
  error?: string;
}

export interface EntryResult {
  success: boolean;
  activated: boolean;
  legsPlaced: number;
  legsFailed: number;
  legs: LegResult[];
  message: string;
}

interface ExitLegResult {
  legId: string;
  instrument: string;
  direction: 'buy' | 'sell'; // direction of the closing order
  amount: number;
  closePrice?: number;
  orderId?: string;
  error?: string;
}

export interface ExitResult {
  success: boolean;
  legsClosed: number;
  legsFailed: number;
  legs: ExitLegResult[];
  message: string;
}

@Injectable()
export class StrategyExecutionService {
  private readonly logger = new Logger(StrategyExecutionService.name);

  constructor(
    private readonly deribitClientService: DeribitClientService,
    private readonly marketDataService: MarketDataService,
    private readonly strategyService: StrategyService,
  ) {}

  /**
   * Activate a strategy and place its initial option legs on Deribit.
   *
   * Flow:
   *  1. Validate strategy state
   *  2. Activate the strategy record (DRAFT/PAUSED → ACTIVE)
   *  3. Resolve the option chain for the configured DTE
   *  4. Build leg orders based on strategy type + params
   *  5. Place each leg as a market order, record to DB
   *  6. Return a human-readable summary suitable for Telegram
   */
  async enterStrategy(userId: string, strategyId: string): Promise<EntryResult> {
    const strategy = await this.strategyService.get(userId, strategyId);

    if (strategy.status === StrategyStatus.CLOSED) {
      return {
        success: false,
        activated: false,
        legsPlaced: 0,
        legsFailed: 0,
        legs: [],
        message: '❌ Cannot re-enter a closed strategy.',
      };
    }

    // Always activate first — even if order placement fails the scheduler can
    // still track the strategy and the user can add legs manually.
    if (strategy.status !== StrategyStatus.ACTIVE) {
      await this.strategyService.activate(userId, strategyId);
    }

    const params = strategy.params as Record<string, any>;
    const currency: 'BTC' | 'ETH' = params.currency === 'ETH' ? 'ETH' : 'BTC';

    // CUSTOM strategies have no auto-entry — user adds legs manually.
    if (strategy.type === StrategyType.CUSTOM) {
      return {
        success: true,
        activated: true,
        legsPlaced: 0,
        legsFailed: 0,
        legs: [],
        message:
          `✅ *${strategy.name}* is now *ACTIVE*\n\n` +
          `CUSTOM strategy — add legs manually via the REST API:\n` +
          `\`POST /trading/buy\` or \`POST /trading/sell\`\n\n` +
          `Scheduler monitors every 15 min once legs are linked.`,
      };
    }

    // Resolve option chain
    const currentPrice = await this.marketDataService.getIndexPrice(currency).catch(() => 0);
    if (currentPrice === 0) {
      return {
        success: true,
        activated: true,
        legsPlaced: 0,
        legsFailed: 0,
        legs: [],
        message:
          `✅ *${strategy.name}* activated, but could not fetch market data to place entry orders. ` +
          `Try placing them manually or wait for the scheduler.`,
      };
    }

    const targetDte: number = params.dte ?? 21;
    const chain = await this.marketDataService.getOptionChain(currency, targetDte, currentPrice);

    if (!chain) {
      return {
        success: true,
        activated: true,
        legsPlaced: 0,
        legsFailed: 0,
        legs: [],
        message:
          `✅ *${strategy.name}* activated, but no option chain found near ${targetDte}d DTE. ` +
          `Place entry orders manually.`,
      };
    }

    // Round allocation to nearest 0.1 BTC (Deribit minimum tick)
    const allocationBtc = Number(strategy.allocationBtc);
    const amount = Math.max(MIN_BTC_AMOUNT, Math.round(allocationBtc * 10) / 10);

    // Build leg structure for this strategy type
    let legOrders: LegOrder[];
    try {
      legOrders = this.buildLegOrders(strategy.type, params, chain, amount);
    } catch (err) {
      return {
        success: true,
        activated: true,
        legsPlaced: 0,
        legsFailed: 0,
        legs: [],
        message: `✅ *${strategy.name}* activated\n\n⚠️ Could not build entry legs: ${err.message}`,
      };
    }

    // Place each leg
    const client = await this.deribitClientService.getClient(userId);
    const results: LegResult[] = [];

    for (const leg of legOrders) {
      try {
        const orderParams = {
          instrument_name: leg.instrument,
          amount: leg.amount,
          type: OrderType.market,
          label: `entry-${strategyId.slice(0, 8)}`,
        };

        const res =
          leg.side === 'sell'
            ? await client.trading.sell(orderParams)
            : await client.trading.buy(orderParams);

        if (!('result' in res)) {
          results.push({ ...leg, error: 'Order rejected by Deribit' });
          continue;
        }

        const order = (res as any).result.order;
        const avgPrice: number = order.average_price > 0 ? order.average_price : 0;

        await this.strategyService.addLeg(strategyId, {
          instrumentName: leg.instrument,
          direction: leg.side,
          quantity: leg.amount,
          openPrice: avgPrice,
          orderId: order.order_id,
        });

        results.push({ ...leg, orderId: order.order_id, avgPrice });

        this.logger.log(
          `Entry leg: ${leg.side} ${leg.amount} ${leg.instrument} @ ${avgPrice} (order ${order.order_id})`,
        );
      } catch (err) {
        results.push({ ...leg, error: err.message });
        this.logger.warn(`Entry leg failed: ${leg.side} ${leg.instrument} — ${err.message}`);
      }
    }

    const placed = results.filter((r) => !r.error);
    const failed = results.filter((r) => !!r.error);

    return {
      success: placed.length > 0,
      activated: true,
      legsPlaced: placed.length,
      legsFailed: failed.length,
      legs: results,
      message: this.buildSummaryMessage(strategy.name, chain, placed, failed),
    };
  }

  // ---------------------------------------------------------------------------
  // Exit execution
  // ---------------------------------------------------------------------------

  /**
   * Close all open legs of a strategy and mark it CLOSED.
   *
   * Each open leg is offset with a market order on the opposite side:
   *   sell leg → buy to close
   *   buy leg  → sell to close
   *
   * `reason` appears in the Telegram notification (e.g. 'manual', 'take-profit', 'stop-loss').
   */
  async exitStrategy(
    userId: string,
    strategyId: string,
    reason: string = 'manual',
  ): Promise<ExitResult> {
    const strategy = await this.strategyService.get(userId, strategyId);

    if (strategy.status === StrategyStatus.CLOSED) {
      return {
        success: false,
        legsClosed: 0,
        legsFailed: 0,
        legs: [],
        message: '⚠️ Strategy is already closed.',
      };
    }

    const openLegs = strategy.legs.filter((l) => l.isOpen);

    // No open legs — just close the strategy record
    if (openLegs.length === 0) {
      await this.strategyService.close(userId, strategyId);
      return {
        success: true,
        legsClosed: 0,
        legsFailed: 0,
        legs: [],
        message: `✅ *${strategy.name}* closed (no open legs to unwind).`,
      };
    }

    const client = await this.deribitClientService.getClient(userId);
    const results: ExitLegResult[] = [];

    for (const leg of openLegs) {
      const closeSide: 'buy' | 'sell' = leg.direction === 'sell' ? 'buy' : 'sell';
      const amount = Number(leg.quantity);

      try {
        const orderParams = {
          instrument_name: leg.instrumentName,
          amount,
          type: OrderType.market,
          label: `exit-${strategyId.slice(0, 8)}`,
          // reduce_only only for perpetuals — prevents accidentally opening a new position
          ...(leg.instrumentName.endsWith('PERPETUAL') ? { reduce_only: true } : {}),
        };

        const res =
          closeSide === 'buy'
            ? await client.trading.buy(orderParams)
            : await client.trading.sell(orderParams);

        if (!('result' in res)) {
          results.push({ legId: leg.id, instrument: leg.instrumentName, direction: closeSide, amount, error: 'Order rejected by Deribit' });
          continue;
        }

        const order = (res as any).result.order;
        const closePrice: number = order.average_price > 0 ? order.average_price : 0;

        await this.strategyService.closeLeg(leg.id, closePrice);

        results.push({
          legId: leg.id,
          instrument: leg.instrumentName,
          direction: closeSide,
          amount,
          closePrice,
          orderId: order.order_id,
        });

        this.logger.log(
          `Exit leg: ${closeSide} ${amount} ${leg.instrumentName} @ ${closePrice} (order ${order.order_id}) [${reason}]`,
        );
      } catch (err) {
        results.push({
          legId: leg.id,
          instrument: leg.instrumentName,
          direction: closeSide,
          amount,
          error: err.message,
        });
        this.logger.warn(`Exit leg failed: ${leg.instrumentName} — ${err.message}`);
      }
    }

    const closed = results.filter((r) => !r.error);
    const failed = results.filter((r) => !!r.error);

    // Only mark the strategy CLOSED when every leg is successfully unwound
    if (failed.length === 0) {
      await this.strategyService.close(userId, strategyId);
    } else {
      this.logger.warn(
        `Strategy ${strategyId} has ${failed.length} failed exit legs — keeping ACTIVE for retry`,
      );
    }

    return {
      success: closed.length > 0,
      legsClosed: closed.length,
      legsFailed: failed.length,
      legs: results,
      message: this.buildExitMessage(strategy.name, closed, failed, reason),
    };
  }

  // ---------------------------------------------------------------------------
  // Leg structure per strategy type
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of orders needed to enter the strategy.
   *
   * Strike resolution (in priority order):
   *   1. params.strike — exact strike requested by the user
   *   2. ATM (straddle / delta-neutral) or ±1 strike OTM (all others)
   *
   * All options are sold as market orders, wings are bought (iron condor).
   */
  private buildLegOrders(
    type: StrategyType,
    params: Record<string, any>,
    chain: OptionChainSummary,
    amount: number,
  ): LegOrder[] {
    const strikes = chain.nearbyStrikes;
    const atmIdx = strikes.findIndex((s) => s.strike === chain.atm);
    if (atmIdx === -1) throw new Error('ATM strike not found in option chain');

    // If the user specified a strike, find its index; fall back to ATM
    const reqIdx = params.strike
      ? strikes.findIndex((s) => s.strike === params.strike)
      : -1;
    const baseIdx = reqIdx !== -1 ? reqIdx : atmIdx;

    const getCall = (idx: number, label: string): string => {
      const s = strikes[idx];
      if (!s?.call) throw new Error(`No call found at ${label} — chain may not cover that strike`);
      return s.call;
    };
    const getPut = (idx: number, label: string): string => {
      const s = strikes[idx];
      if (!s?.put) throw new Error(`No put found at ${label} — chain may not cover that strike`);
      return s.put;
    };

    switch (type) {
      // ---- Sell both sides at-the-money ----
      case StrategyType.STRADDLE:
      case StrategyType.DELTA_NEUTRAL:
        return [
          { instrument: getCall(atmIdx, 'ATM call'), side: 'sell', amount },
          { instrument: getPut(atmIdx, 'ATM put'),  side: 'sell', amount },
        ];

      // ---- Sell OTM call + OTM put (one strike each side of ATM) ----
      case StrategyType.STRANGLE:
        return [
          { instrument: getCall(atmIdx + 1, 'OTM call'), side: 'sell', amount },
          { instrument: getPut(atmIdx - 1, 'OTM put'),   side: 'sell', amount },
        ];

      // ---- Sell one OTM call only ----
      case StrategyType.COVERED_CALL:
        return [
          { instrument: getCall(baseIdx + 1, 'OTM call'), side: 'sell', amount },
        ];

      // ---- Sell one OTM put only ----
      case StrategyType.CASH_SECURED_PUT:
      case StrategyType.WHEEL:
        return [
          { instrument: getPut(baseIdx - 1, 'OTM put'), side: 'sell', amount },
        ];

      // ---- Sell OTM put + call, buy further OTM wings ----
      case StrategyType.IRON_CONDOR:
        return [
          { instrument: getPut(atmIdx - 1,  'short put'),   side: 'sell', amount },
          { instrument: getPut(atmIdx - 2,  'long put'),    side: 'buy',  amount },
          { instrument: getCall(atmIdx + 1, 'short call'),  side: 'sell', amount },
          { instrument: getCall(atmIdx + 2, 'long call'),   side: 'buy',  amount },
        ];

      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Telegram summary message
  // ---------------------------------------------------------------------------

  private buildExitMessage(
    name: string,
    closed: ExitLegResult[],
    failed: ExitLegResult[],
    reason: string,
  ): string {
    const reasonLabel: Record<string, string> = {
      manual:       '🔴 Manual close',
      'take-profit': '🎯 Take-profit hit',
      'stop-loss':   '🛑 Stop-loss hit',
    };
    const lines: string[] = [
      `${reasonLabel[reason] ?? '🔴 Closed'} — *${name}*`,
      '',
    ];

    for (const l of closed) {
      lines.push(
        `✅ ${l.direction.toUpperCase()} \`${l.instrument}\` ×\`${l.amount} BTC\`` +
        (l.closePrice ? ` @ \`$${l.closePrice.toLocaleString()}\`` : ''),
      );
    }
    for (const l of failed) {
      lines.push(`❌ ${l.direction.toUpperCase()} \`${l.instrument}\` — ${l.error}`);
    }

    if (failed.length === 0) {
      lines.push('\nAll positions closed. Strategy is *CLOSED*.');
    } else {
      lines.push(`\n⚠️ ${failed.length} leg(s) failed to close — strategy remains ACTIVE. Retry with /strategy_close.`);
    }

    return lines.join('\n');
  }

  private buildSummaryMessage(
    name: string,
    chain: OptionChainSummary,
    placed: LegResult[],
    failed: LegResult[],
  ): string {
    const lines: string[] = [
      `✅ *${name}* is now *ACTIVE*`,
      `Expiry: \`${chain.expiry}\` (${chain.actualDte}d) · ATM: \`$${chain.atm.toLocaleString()}\``,
      '',
    ];

    for (const l of placed) {
      lines.push(
        `✅ ${l.side.toUpperCase()} \`${l.instrument}\` ×\`${l.amount} BTC\`` +
        (l.avgPrice ? ` @ \`$${l.avgPrice.toLocaleString()}\`` : ''),
      );
    }
    for (const l of failed) {
      lines.push(`❌ ${l.side.toUpperCase()} \`${l.instrument}\` — ${l.error}`);
    }

    if (placed.length > 0) {
      lines.push('\nScheduler checks delta & rebalance every 15 min.');
    } else if (failed.length > 0) {
      lines.push('\n⚠️ Strategy activated but all orders failed. Place legs manually.');
    }

    return lines.join('\n');
  }
}
