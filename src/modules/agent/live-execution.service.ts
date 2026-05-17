import { Injectable, Logger } from '@nestjs/common';
import { OrderType, TimeInForce } from '@wrytlabs/deribit-api-client';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LivePosition {
  label:        string;    // e.g. "BTC-21MAY26-100000-C"
  optionType:   'call' | 'put';
  strike:       number;
  expiryDate:   string;    // ISO date "2026-05-21" — source of truth for DTE
  size:         number;    // BTC amount
  entryPremBtc: number;    // fill price per BTC at open
  openFeeBtc:   number;    // total fee paid at open
  openOrderId:  string;    // Deribit order_id
  lastMktPrem:  number;    // updated by mark-to-market
  openedAt:     string;    // ISO date
}

export interface LiveState {
  lastTickDate:    string;
  stepCount:       number;
  initialBtcPrice: number;
  prevEquity:      number;
  equityHistory:   number[];
  openPositions:   LivePosition[];
}

export interface FillResult {
  filled:       boolean;
  orderId:      string;
  fillPriceBtc: number;
  feeBtc:       number;
}

export interface SnapResult {
  instrumentName: string;
  strike:         number;
  expiryDate:     string;   // ISO date
  actualDte:      number;
}

export interface MarkResult {
  entries:            Record<string, unknown>[];
  updatedPositions:   LivePosition[];
  settledPnlBtc:      number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DERIBIT_REST = 'https://www.deribit.com/api/v2/public';

@Injectable()
export class LiveExecutionService {
  private readonly logger = new Logger(LiveExecutionService.name);

  constructor(private readonly deribitClient: DeribitClientService) {}

  // ---------------------------------------------------------------------------
  // Instrument snapping
  // ---------------------------------------------------------------------------

  /**
   * Find the nearest real Deribit instrument for a predicted leg.
   * Uses REST to avoid WebSocket staleness.
   */
  async snapInstrument(
    currency: string,
    optionType: 'call' | 'put',
    targetStrike: number,
    dteDays: number,
  ): Promise<SnapResult | null> {
    try {
      const url = new URL(`${DERIBIT_REST}/get_instruments`);
      url.searchParams.set('currency', currency);
      url.searchParams.set('kind', 'option');
      url.searchParams.set('expired', 'false');

      const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const json = await res.json() as { result?: any[] };
      if (!Array.isArray(json.result)) return null;

      const now       = Date.now();
      const targetMs  = dteDays * 86_400_000;

      // Find the expiry whose DTE is closest to the target
      const expiries = new Map<number, any[]>();
      for (const inst of json.result) {
        if (!inst.is_active) continue;
        const bucket = expiries.get(inst.expiration_timestamp) ?? [];
        bucket.push(inst);
        expiries.set(inst.expiration_timestamp, bucket);
      }

      let bestExpiry = 0;
      let bestDiff   = Infinity;
      for (const ts of expiries.keys()) {
        const dte  = (ts - now) / 86_400_000;
        if (dte < 0.5) continue;
        const diff = Math.abs(dte - dteDays);
        if (diff < bestDiff) { bestDiff = diff; bestExpiry = ts; }
      }
      if (!bestExpiry) return null;

      const instruments = expiries.get(bestExpiry)!;
      const actualDte   = Math.round((bestExpiry - now) / 86_400_000);
      const expiryDate  = new Date(bestExpiry).toISOString().split('T')[0];

      // Among same-expiry instruments of the right type, pick nearest strike
      const filtered = instruments.filter(
        (i) => i.option_type === optionType && typeof i.strike === 'number',
      );
      if (!filtered.length) return null;

      const nearest = filtered.reduce((best, inst) =>
        Math.abs(inst.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? inst : best,
      );

      return {
        instrumentName: nearest.instrument_name,
        strike:         nearest.strike,
        expiryDate,
        actualDte,
      };
    } catch (err: any) {
      this.logger.error(`snapInstrument failed: ${err?.message ?? String(err)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Order placement
  // ---------------------------------------------------------------------------

  /**
   * Place a market IOC order and return fill details.
   * Uses immediate_or_cancel — fills instantly or not at all, no open orders left.
   */
  async placeAndAwaitFill(
    userId:         string,
    side:           'buy' | 'sell',
    instrumentName: string,
    amount:         number,
  ): Promise<FillResult> {
    const empty: FillResult = { filled: false, orderId: '', fillPriceBtc: 0, feeBtc: 0 };
    try {
      const client = await this.deribitClient.getClient(userId);
      const params = {
        instrument_name: instrumentName,
        amount,
        type:          OrderType.market,
        time_in_force: TimeInForce.immediate_or_cancel,
      };

      const res    = side === 'sell'
        ? await client.trading.sell(params)
        : await client.trading.buy(params);
      const result = this.deribitClient.unwrap(res) as { order: any; trades: any[] };

      const trades = result.trades ?? [];
      if (!trades.length) {
        this.logger.warn(`${side} ${amount} ${instrumentName} — no fills (IOC rejected)`);
        return empty;
      }

      const totalAmount = trades.reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
      const fillPrice   = trades.reduce((s: number, t: any) => s + (t.price ?? 0) * (t.amount ?? 0), 0) / totalAmount;
      const fee         = trades.reduce((s: number, t: any) => s + (t.fee ?? 0), 0);

      this.logger.log(
        `${side} ${amount} ${instrumentName} filled @ ${fillPrice.toFixed(6)} BTC  fee=${fee.toFixed(8)} BTC`,
      );

      return {
        filled:       true,
        orderId:      result.order.order_id,
        fillPriceBtc: fillPrice,
        feeBtc:       fee,
      };
    } catch (err: any) {
      this.logger.error(`placeAndAwaitFill failed (${side} ${instrumentName}): ${err?.message ?? String(err)}`);
      return empty;
    }
  }

  // ---------------------------------------------------------------------------
  // Mark-to-market
  // ---------------------------------------------------------------------------

  /**
   * Process open positions for a live run:
   * - Positions with DTE ≤ 0: detect Deribit settlement, log settlement_expired, remove.
   * - Positions with DTE > 0: fetch real mark price + greeks, log settlement_unrealized.
   *
   * Returns log entries + updated positions list + total settled P&L.
   */
  async markOpenPositions(
    userId:         string,
    openPositions:  LivePosition[],
    marginBalance:  number,
    currentDate:    Date,
  ): Promise<MarkResult> {
    const entries:          Record<string, unknown>[] = [];
    const updatedPositions: LivePosition[]            = [];
    let   settledPnlBtc = 0;
    let   ms            = 0; // millisecond offset for sequential timestamps

    const ts = (offset: number) =>
      new Date(currentDate.getTime() + offset).toISOString().replace(/(\.\d{3})Z$/, '$1Z');

    for (const pos of openPositions) {
      const expiryMs = new Date(pos.expiryDate).setHours(0, 0, 0, 0);
      const todayMs  = new Date(currentDate).setHours(0, 0, 0, 0);
      const dte      = Math.max(0, Math.round((expiryMs - todayMs) / 86_400_000));

      if (dte === 0) {
        // Expired — settle at intrinsic value using Deribit index price
        const btcPrice = await this.getBtcIndexPrice().catch(() => 0);
        let intrinsicBtc = 0;

        if (btcPrice > 0) {
          const intrinsicUsd = pos.optionType === 'call'
            ? Math.max(btcPrice - pos.strike, 0)
            : Math.max(pos.strike - btcPrice, 0);
          intrinsicBtc = intrinsicUsd / btcPrice;
        }

        // pnl = (entry_prem - intrinsic - open_fee_per_unit) * size
        const openFeePerUnit = pos.openFeeBtc / Math.max(pos.size, 1e-8);
        const pnl = (pos.entryPremBtc - intrinsicBtc - openFeePerUnit) * pos.size;
        marginBalance += -intrinsicBtc * pos.size;
        settledPnlBtc += pnl;

        const liability = updatedPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
        entries.push({
          actionType:       'settlement_expired',
          timestamp:        ts(ms++),
          instrument:       pos.label,
          quantity:         pos.size,
          price:            intrinsicBtc,
          executedPrice:    pos.entryPremBtc,
          pnlBtc:           pnl,
          feeBtc:           0,
          cashflowBtc:      -intrinsicBtc * pos.size,
          marginBalanceBtc: marginBalance,
          equityBtc:        marginBalance - liability,
          reason:           intrinsicBtc > 0 ? 'expired ITM' : 'expired OTM',
        });
        // Don't add to updatedPositions — position is gone
        continue;
      }

      // Still alive — get real mark from Deribit
      let markPriceBtc = pos.lastMktPrem;
      let delta: number | undefined;

      try {
        const client = await this.deribitClient.getClient(userId);
        const posRes = await client.account.getPosition({ instrument_name: pos.label });
        const posData = this.deribitClient.unwrap(posRes) as any;
        if (posData?.mark_price != null) markPriceBtc = Number(posData.mark_price);
        if (posData?.delta      != null) delta        = Number(posData.delta);
      } catch {
        // Fallback: keep lastMktPrem
      }

      const updated: LivePosition = { ...pos, lastMktPrem: markPriceBtc };
      updatedPositions.push(updated);

      const liability = updatedPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
      const entry: Record<string, unknown> = {
        actionType:       'settlement_unrealized',
        timestamp:        ts(ms++),
        instrument:       pos.label,
        quantity:         pos.size,
        price:            markPriceBtc,
        executedPrice:    pos.entryPremBtc,
        marginBalanceBtc: marginBalance,
        equityBtc:        marginBalance - liability,
        reason:           'daily mark',
      };
      if (delta !== undefined) entry['delta'] = delta;
      entries.push(entry);
    }

    return { entries, updatedPositions, settledPnlBtc };
  }

  // ---------------------------------------------------------------------------
  // Account helpers
  // ---------------------------------------------------------------------------

  async getAccountEquity(userId: string, currency: string): Promise<number> {
    const client  = await this.deribitClient.getClient(userId);
    const res     = await client.account.getAccountSummary({ currency: currency as any });
    const summary = this.deribitClient.unwrap(res) as any;
    return Number(summary.equity ?? summary.balance);
  }

  private async getBtcIndexPrice(): Promise<number> {
    const url = new URL(`${DERIBIT_REST}/get_index_price`);
    url.searchParams.set('index_name', 'btc_usd');
    const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
    const json = await res.json() as any;
    return Number(json.result?.index_price ?? 0);
  }
}
