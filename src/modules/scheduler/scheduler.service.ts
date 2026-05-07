import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import { StrategyService } from '../strategy/strategy.service';
import { StrategyExecutionService } from '../strategy/strategy-execution.service';
import { StrategyStatus, StrategyType } from '@prisma/client';
import { OrderType } from '@wrytlabs/deribit-api-client';

/** BTC-PERPETUAL is the hedge instrument for delta-neutral strategies. */
const HEDGE_INSTRUMENT = 'BTC-PERPETUAL';

/**
 * Skip auto-hedge when |delta| is below this threshold — avoids
 * churning over negligible residual exposure from rounding.
 */
const MIN_HEDGE_DELTA_BTC = 0.001;

/** Deribit minimum contract size for BTC-PERPETUAL (USD, 10 USD increment). */
const MIN_HEDGE_USD = 10;

type HedgeResult =
  | {
      executed: true;
      side: 'buy' | 'sell';
      sizeUsd: number;
      avgPrice: number;
      deltaOffset: number;  // BTC notional hedged
      orderId: string;
    }
  | { executed: false; reason: string };

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly marketDataService: MarketDataService,
    private readonly telegramService: TelegramService,
    private readonly strategyService: StrategyService,
    private readonly strategyExecutionService: StrategyExecutionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Hourly: market snapshot + strategy snapshots
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_HOUR)
  async takeHourlySnapshots() {
    this.logger.log('Hourly snapshot run started');

    try {
      const conditions = await this.marketDataService.getAllConditions();
      for (const c of conditions) {
        if (c.indexPrice > 0) await this.marketDataService.saveSnapshot(c);
      }
    } catch (err) {
      this.logger.error(`Market snapshot failed: ${err.message}`);
    }

    const activeStrategies = await this.prisma.strategy.findMany({
      where: { status: StrategyStatus.ACTIVE },
      include: {
        legs: { where: { isOpen: true } },
        user: true,
      },
    });

    for (const strategy of activeStrategies) {
      await this.takeStrategySnapshot(strategy);
    }

    this.logger.log(`Hourly snapshot complete — ${activeStrategies.length} strategies processed`);
  }

  // ---------------------------------------------------------------------------
  // Every 15 min: check rebalance triggers + execute hedge
  // ---------------------------------------------------------------------------

  @Cron('*/15 * * * *')
  async checkRebalanceTriggers() {
    const activeStrategies = await this.prisma.strategy.findMany({
      where: { status: StrategyStatus.ACTIVE },
      include: {
        user: true,
        legs: { where: { isOpen: true } },
        snapshots: { orderBy: { timestamp: 'desc' }, take: 1 },
      },
    });

    for (const strategy of activeStrategies) {
      const params = strategy.params as Record<string, any>;
      const chatId = Number(strategy.user.telegramId);

      try {
        // ---- 1. Take-profit / stop-loss check (runs first — exits before rebalancing) ----
        const latest = strategy.snapshots[0];
        const pnl = latest?.unrealizedPnlBtc !== null ? Number(latest?.unrealizedPnlBtc) : null;

        if (pnl !== null && (params.takeProfitPct || params.stopLossPct)) {
          // Reference = net premium collected at entry (sell legs – buy legs).
          // Falls back to 2% of allocation if no leg data.
          const netCredit = strategy.legs.reduce((acc, leg) => {
            const sign = leg.direction === 'sell' ? 1 : -1;
            return acc + sign * Number(leg.quantity) * Number(leg.openPrice);
          }, 0);
          const ref = netCredit > 0 ? netCredit : Number(strategy.allocationBtc) * 0.02;

          const tpThreshold = params.takeProfitPct ? ref * (params.takeProfitPct / 100) : null;
          const slThreshold = params.stopLossPct  ? ref * (params.stopLossPct  / 100) : null;

          if (tpThreshold !== null && pnl >= tpThreshold) {
            this.logger.log(`Take-profit hit for strategy ${strategy.id} — P&L ${pnl.toFixed(6)} BTC`);
            const result = await this.strategyExecutionService.exitStrategy(
              strategy.userId, strategy.id, 'take-profit',
            );
            const pct = ((pnl / ref) * 100).toFixed(1);
            await this.sendSafeMarkdown(
              chatId,
              `🎯 *Take-profit triggered* — ${strategy.name}\n` +
              `P&L: \`+${pnl.toFixed(6)} BTC\` (\`${pct}%\` of credit)\n\n` +
              result.message,
            );
            continue; // strategy is now CLOSED — skip rebalance
          }

          if (slThreshold !== null && pnl <= -slThreshold) {
            this.logger.log(`Stop-loss hit for strategy ${strategy.id} — P&L ${pnl.toFixed(6)} BTC`);
            const result = await this.strategyExecutionService.exitStrategy(
              strategy.userId, strategy.id, 'stop-loss',
            );
            const pct = ((Math.abs(pnl) / ref) * 100).toFixed(1);
            await this.sendSafeMarkdown(
              chatId,
              `🛑 *Stop-loss triggered* — ${strategy.name}\n` +
              `Loss: \`${pnl.toFixed(6)} BTC\` (\`${pct}%\` of credit)\n\n` +
              result.message,
            );
            continue; // strategy is now CLOSED — skip rebalance
          }
        }

        // ---- 2. Rebalance / delta-hedge check ----
        const trigger = params?.rebalanceTriggerUsd;
        if (!trigger || trigger <= 0) continue;

        const btcPrice = await this.marketDataService.getIndexPrice('BTC');
        const lastPrice: number = params.lastRebalanceBtcPrice ?? btcPrice;
        const drift = Math.abs(btcPrice - lastPrice);

        if (drift < trigger) continue;

        const direction = btcPrice > lastPrice ? '📈' : '📉';

        const shouldHedge =
          strategy.type === StrategyType.DELTA_NEUTRAL && strategy.legs.length > 0;

        let hedgeResult: HedgeResult | null = null;
        if (shouldHedge) {
          hedgeResult = await this.executeHedge(strategy, btcPrice);
        }

        const header =
          `⚖️ *Rebalance Triggered* — ${strategy.name}\n\n` +
          `${direction} BTC moved \`$${drift.toFixed(0)}\` ` +
          `(trigger: \`$${trigger}\`)\n` +
          `Last: \`$${lastPrice.toLocaleString()}\` → Now: \`$${btcPrice.toLocaleString()}\``;

        let msg: string;
        if (hedgeResult?.executed) {
          msg =
            header + '\n\n' +
            `✅ *Hedge executed*\n` +
            `${hedgeResult.side === 'sell' ? 'Sold' : 'Bought'} \`${hedgeResult.sizeUsd.toLocaleString()} USD\` ` +
            `${HEDGE_INSTRUMENT} @ \`$${hedgeResult.avgPrice.toLocaleString()}\`\n` +
            `Delta offset: \`${hedgeResult.deltaOffset.toFixed(4)} BTC\`\n` +
            `Order: \`${hedgeResult.orderId}\``;
        } else if (hedgeResult && !hedgeResult.executed) {
          msg = header + `\n\n⚠️ *Auto-hedge skipped:* ${hedgeResult.reason}\n\nManual adjustment needed.`;
        } else {
          msg = header + '\n\nTime to check your delta hedge.';
        }

        await this.sendSafeMarkdown(chatId, msg);

        await this.prisma.strategy.update({
          where: { id: strategy.id },
          data: { params: { ...(strategy.params as object), lastRebalanceBtcPrice: btcPrice } },
        });

        this.logger.log(
          `Rebalance ${strategy.id} — drift $${drift.toFixed(0)}` +
          (hedgeResult?.executed ? `, hedged ${hedgeResult.sizeUsd} USD` : ''),
        );
      } catch (err) {
        this.logger.warn(`15-min check failed for ${strategy.id}: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: hedge execution
  // ---------------------------------------------------------------------------

  /**
   * Fetch live portfolio delta across all open option legs, then place a
   * BTC-PERPETUAL market order to bring delta back to zero.
   *
   * Direction:
   *   - delta > 0 (net long delta) → sell BTC-PERPETUAL
   *   - delta < 0 (net short delta) → buy BTC-PERPETUAL
   *
   * Amount: rounded to the nearest 10 USD (Deribit minimum tick).
   */
  private async executeHedge(
    strategy: {
      id: string;
      userId: string;
      legs: { instrumentName: string }[];
    },
    btcPrice: number,
  ): Promise<HedgeResult> {
    // 1. Fetch live delta from Deribit for every open leg
    let liveDelta = 0;
    let hasDelta = false;

    try {
      const client = await this.deribitClientService.getClient(strategy.userId);
      const posResults = await Promise.allSettled(
        strategy.legs.map((leg) =>
          client.account.getPosition({ instrument_name: leg.instrumentName }),
        ),
      );
      for (const r of posResults) {
        if (r.status === 'fulfilled' && 'result' in r.value) {
          liveDelta += (r.value.result as any).delta ?? 0;
          hasDelta = true;
        }
      }
    } catch (err) {
      return { executed: false, reason: `Could not fetch live positions: ${err.message}` };
    }

    if (!hasDelta) {
      return { executed: false, reason: 'No position data returned from Deribit' };
    }

    // 2. Guard: skip if delta is already flat enough
    if (Math.abs(liveDelta) < MIN_HEDGE_DELTA_BTC) {
      return {
        executed: false,
        reason: `Delta ${liveDelta.toFixed(4)} BTC is within the ${MIN_HEDGE_DELTA_BTC} BTC threshold`,
      };
    }

    // 3. Size the hedge in USD (Deribit perp is denominated in USD)
    const rawSizeUsd = Math.abs(liveDelta) * btcPrice;
    const hedgeSizeUsd = Math.round(rawSizeUsd / 10) * 10;

    if (hedgeSizeUsd < MIN_HEDGE_USD) {
      return {
        executed: false,
        reason: `Hedge notional $${rawSizeUsd.toFixed(2)} is below Deribit minimum $${MIN_HEDGE_USD}`,
      };
    }

    // 4. Place market order
    const side: 'buy' | 'sell' = liveDelta > 0 ? 'sell' : 'buy';

    try {
      const client = await this.deribitClientService.getClient(strategy.userId);
      const orderParams = {
        instrument_name: HEDGE_INSTRUMENT,
        amount: hedgeSizeUsd,
        type: OrderType.market,
        label: `hedge-${strategy.id.slice(0, 8)}`,
      };

      const res =
        side === 'sell'
          ? await client.trading.sell(orderParams)
          : await client.trading.buy(orderParams);

      if (!('result' in res)) {
        return { executed: false, reason: 'Deribit rejected the order' };
      }

      const order = (res as any).result.order;
      const avgPrice: number = order.average_price > 0 ? order.average_price : btcPrice;
      const btcNotional = hedgeSizeUsd / avgPrice;

      // 5. Record as a strategy leg so the snapshot can track it
      await this.strategyService.addLeg(strategy.id, {
        instrumentName: HEDGE_INSTRUMENT,
        direction: side,
        quantity: btcNotional,
        openPrice: avgPrice,
        orderId: order.order_id,
      });

      this.logger.log(
        `Hedge executed for strategy ${strategy.id}: ${side} ${hedgeSizeUsd} USD ` +
        `${HEDGE_INSTRUMENT} @ $${avgPrice} (order ${order.order_id})`,
      );

      return {
        executed: true,
        side,
        sizeUsd: hedgeSizeUsd,
        avgPrice,
        deltaOffset: btcNotional,
        orderId: order.order_id,
      };
    } catch (err) {
      return { executed: false, reason: `Order failed: ${err.message}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: strategy snapshot (unchanged)
  // ---------------------------------------------------------------------------

  private async takeStrategySnapshot(strategy: {
    id: string;
    userId: string;
    legs: { instrumentName: string; direction: string; quantity: any; openPrice: any }[];
    user: { telegramId: bigint };
  }) {
    const btcPrice = await this.marketDataService.getIndexPrice('BTC').catch(() => 0);

    if (strategy.legs.length === 0) {
      await this.prisma.strategySnapshot.create({
        data: { strategyId: strategy.id, btcIndexPrice: btcPrice },
      });
      return;
    }

    let delta = 0, gamma = 0, theta = 0, vega = 0, unrealizedPnlBtc = 0;
    let hasPositionData = false;

    try {
      const client = await this.deribitClientService.getClient(strategy.userId);
      const posResults = await Promise.allSettled(
        strategy.legs.map((leg) =>
          client.account.getPosition({ instrument_name: leg.instrumentName }),
        ),
      );
      for (const res of posResults) {
        if (res.status !== 'fulfilled') continue;
        const pos = res.value;
        if (!('result' in pos)) continue;
        const p = pos.result as any;
        delta              += p.delta ?? 0;
        gamma              += p.gamma ?? 0;
        theta              += p.theta ?? 0;
        vega               += p.vega  ?? 0;
        unrealizedPnlBtc   += p.floating_profit_loss ?? 0;
        hasPositionData = true;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch positions for strategy ${strategy.id}: ${err.message}`);
    }

    await this.prisma.strategySnapshot.create({
      data: {
        strategyId: strategy.id,
        btcIndexPrice: btcPrice,
        delta:           hasPositionData ? delta           : undefined,
        gamma:           hasPositionData ? gamma           : undefined,
        theta:           hasPositionData ? theta           : undefined,
        vega:            hasPositionData ? vega            : undefined,
        unrealizedPnlBtc: hasPositionData ? unrealizedPnlBtc : undefined,
      },
    });
  }

  private async sendSafeMarkdown(chatId: number, text: string) {
    try {
      await this.telegramService.sendMarkdownMessage(chatId, text);
    } catch (err) {
      if (err?.message?.includes('Bad Request') || err?.message?.includes("can't parse entities")) {
        await this.telegramService.sendMessage(chatId, text);
      } else {
        this.logger.warn(`Alert delivery failed to ${chatId}: ${err.message}`);
      }
    }
  }
}
