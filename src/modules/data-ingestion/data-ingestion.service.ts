import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { createDeribitClientPublic, DeribitApiClient } from '@wrytlabs/deribit-api-client';

export interface BackfillDto {
  instrument: string;
  resolution: string;
  from: Date;
  to?: Date;
}

export interface BackfillResult {
  instrument: string;
  resolution: string;
  inserted: number;
  skipped: number;
  fromTs: number;
  toTs: number;
}

export interface OptionSnapshotResult {
  currency: string;
  captured: number;
  errors: number;
}

/** Deribit chart data max range per resolution (ms) to stay within API limits. */
const MAX_RANGE_MS: Record<string, number> = {
  '1':    7  * 24 * 3600 * 1000,
  '3':    7  * 24 * 3600 * 1000,
  '5':    14 * 24 * 3600 * 1000,
  '10':   14 * 24 * 3600 * 1000,
  '15':   30 * 24 * 3600 * 1000,
  '30':   30 * 24 * 3600 * 1000,
  '60':   60 * 24 * 3600 * 1000,
  '120':  90 * 24 * 3600 * 1000,
  '180':  90 * 24 * 3600 * 1000,
  '360': 180 * 24 * 3600 * 1000,
  '720': 365 * 24 * 3600 * 1000,
  '1D':  730 * 24 * 3600 * 1000,
  '1W': 1825 * 24 * 3600 * 1000,
};

@Injectable()
export class DataIngestionService {
  private readonly logger = new Logger(DataIngestionService.name);
  private client: DeribitApiClient;

  constructor(private readonly prisma: PrismaService) {
    this.client = createDeribitClientPublic();
  }

  // ---------------------------------------------------------------------------
  // Candle ingestion
  // ---------------------------------------------------------------------------

  /**
   * Backfill OHLCV candles for a given instrument and resolution.
   * Automatically chunks the request to stay within Deribit's API range limits.
   * Skips candles already present in the DB (upsert semantics via unique index).
   */
  async backfillCandles(dto: BackfillDto): Promise<BackfillResult> {
    const toDate = dto.to ?? new Date();
    const fromTs = dto.from.getTime();
    const toTs   = toDate.getTime();
    const maxRange = MAX_RANGE_MS[dto.resolution] ?? 60 * 24 * 3600 * 1000;

    let inserted = 0;
    let skipped  = 0;
    let cursor   = fromTs;

    while (cursor < toTs) {
      const chunkEnd = Math.min(cursor + maxRange, toTs);

      const res = await (this.client as any).market.getTradingviewChartData({
        instrument_name: dto.instrument,
        start_timestamp: cursor,
        end_timestamp:   chunkEnd,
        resolution:      dto.resolution,
      });

      if (!('result' in res) || !res.result?.ticks?.length) {
        cursor = chunkEnd;
        continue;
      }

      const { ticks, open, high, low, close, volume } = res.result;

      for (let i = 0; i < ticks.length; i++) {
        const timestamp = new Date(ticks[i]);

        try {
          await this.prisma.candle.upsert({
            where: {
              instrument_resolution_timestamp: {
                instrument:  dto.instrument,
                resolution:  dto.resolution,
                timestamp,
              },
            },
            update: {},
            create: {
              instrument: dto.instrument,
              resolution: dto.resolution,
              timestamp,
              open:   open[i],
              high:   high[i],
              low:    low[i],
              close:  close[i],
              volume: volume?.[i] ?? 0,
            },
          });
          inserted++;
        } catch {
          skipped++;
        }
      }

      this.logger.log(
        `Candle chunk [${dto.instrument} ${dto.resolution}] ` +
        `${new Date(cursor).toISOString()} → ${new Date(chunkEnd).toISOString()}: ` +
        `+${inserted} inserted`,
      );

      cursor = chunkEnd;
    }

    return { instrument: dto.instrument, resolution: dto.resolution, inserted, skipped, fromTs, toTs };
  }

  /**
   * Fetch the latest candle batch for an instrument and append any new ones.
   * Used by the scheduler to keep data current.
   */
  async ingestLatestCandles(instrument: string, resolution: string): Promise<number> {
    const latest = await this.prisma.candle.findFirst({
      where: { instrument, resolution },
      orderBy: { timestamp: 'desc' },
    });

    const from = latest
      ? new Date(latest.timestamp.getTime() + 1)
      : new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30 days default lookback

    const result = await this.backfillCandles({ instrument, resolution, from });
    return result.inserted;
  }

  /** Query stored candles with optional time range. */
  async queryCandles(
    instrument: string,
    resolution: string,
    from?: Date,
    to?: Date,
    limit?: number,
  ) {
    return this.prisma.candle.findMany({
      where: {
        instrument,
        resolution,
        ...(from || to
          ? {
              timestamp: {
                ...(from ? { gte: from } : {}),
                ...(to   ? { lte: to   } : {}),
              },
            }
          : {}),
      },
      orderBy: { timestamp: 'asc' },
      ...(limit ? { take: limit } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Options chain snapshot
  // ---------------------------------------------------------------------------

  /**
   * Snapshot the full options IV surface for a currency.
   * Fetches mark prices, IVs, and greeks for all active option instruments.
   */
  async snapshotOptionChain(currency: 'BTC' | 'ETH'): Promise<OptionSnapshotResult> {
    const instrumentsRes = await this.client.market.getInstruments({
      currency,
      kind: 'option',
      expired: false,
    });

    if (!('result' in instrumentsRes) || !Array.isArray(instrumentsRes.result)) {
      return { currency, captured: 0, errors: 1 };
    }

    const activeInstruments = instrumentsRes.result
      .filter((i: any) => i.is_active)
      .map((i: any) => i.instrument_name as string);

    const capturedAt = new Date();
    let captured = 0;
    let errors   = 0;

    // Fetch in batches of 20 to avoid hammering the API
    const BATCH = 20;
    for (let i = 0; i < activeInstruments.length; i += BATCH) {
      const batch = activeInstruments.slice(i, i + BATCH);

      const results = await Promise.allSettled(
        batch.map((name) =>
          (this.client.market as any).getTicker({ instrument_name: name }),
        ),
      );

      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        const name = batch[j];

        if (res.status !== 'fulfilled' || !('result' in res.value)) {
          errors++;
          continue;
        }

        const t = res.value.result as any;
        const parts = name.split('-'); // BTC-28MAR25-70000-C
        if (parts.length < 4) { errors++; continue; }

        const expiry     = parts[1];
        const strike     = parseFloat(parts[2]);
        const optionType = parts[3].toLowerCase() === 'c' ? 'call' : 'put';

        try {
          await this.prisma.optionSnapshot.create({
            data: {
              capturedAt,
              instrument:      name,
              currency,
              expiry,
              strike,
              optionType,
              markIv:          t.mark_iv    ?? undefined,
              bidIv:           t.bid_iv     ?? undefined,
              askIv:           t.ask_iv     ?? undefined,
              markPrice:       t.mark_price ?? undefined,
              bidPrice:        t.best_bid_price  ?? undefined,
              askPrice:        t.best_ask_price  ?? undefined,
              underlyingPrice: t.underlying_price ?? undefined,
              delta:           t.greeks?.delta   ?? undefined,
              gamma:           t.greeks?.gamma   ?? undefined,
              theta:           t.greeks?.theta   ?? undefined,
              vega:            t.greeks?.vega    ?? undefined,
              rho:             t.greeks?.rho     ?? undefined,
              openInterest:    t.open_interest   ?? undefined,
              volume24h:       t.stats?.volume   ?? undefined,
            },
          });
          captured++;
        } catch (err) {
          this.logger.warn(`Failed to save snapshot for ${name}: ${err.message}`);
          errors++;
        }
      }
    }

    this.logger.log(`Option snapshot [${currency}]: ${captured} rows, ${errors} errors`);
    return { currency, captured, errors };
  }

  /** Query option snapshots for a specific expiry and capture time window. */
  async queryOptionSnapshots(
    currency: string,
    expiry?: string,
    from?: Date,
    to?: Date,
    limit?: number,
  ) {
    return this.prisma.optionSnapshot.findMany({
      where: {
        currency,
        ...(expiry ? { expiry } : {}),
        ...(from || to
          ? {
              capturedAt: {
                ...(from ? { gte: from } : {}),
                ...(to   ? { lte: to   } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ expiry: 'asc' }, { strike: 'asc' }, { capturedAt: 'desc' }],
      ...(limit ? { take: limit } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getCandleStats() {
    const rows = await this.prisma.$queryRaw<
      { instrument: string; resolution: string; count: bigint; min_ts: Date; max_ts: Date }[]
    >`
      SELECT instrument, resolution,
             COUNT(*)    AS count,
             MIN(timestamp) AS min_ts,
             MAX(timestamp) AS max_ts
      FROM "Candle"
      GROUP BY instrument, resolution
      ORDER BY instrument, resolution
    `;
    return rows.map((r) => ({
      instrument: r.instrument,
      resolution: r.resolution,
      count: Number(r.count),
      from: r.min_ts,
      to:   r.max_ts,
    }));
  }

  async getOptionSnapshotStats() {
    const rows = await this.prisma.$queryRaw<
      { currency: string; count: bigint; min_ts: Date; max_ts: Date }[]
    >`
      SELECT currency,
             COUNT(*) AS count,
             MIN("capturedAt") AS min_ts,
             MAX("capturedAt") AS max_ts
      FROM "OptionSnapshot"
      GROUP BY currency
    `;
    return rows.map((r) => ({
      currency: r.currency,
      count: Number(r.count),
      from: r.min_ts,
      to:   r.max_ts,
    }));
  }
}
