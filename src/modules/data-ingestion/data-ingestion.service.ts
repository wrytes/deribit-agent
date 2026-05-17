import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import {
	createDeribitClientPublic,
	DeribitApiClient,
} from '@wrytes/deribit-api-client';

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

// ---------------------------------------------------------------------------
// Default tracking config
// ---------------------------------------------------------------------------

/** Instruments kept live by the hourly scheduler. Spot index is 1D only (no hourly from Deribit). */
export const TRACKED_INSTRUMENTS: { instrument: string; resolution: string }[] =
	[
		{ instrument: 'BTC-PERPETUAL', resolution: '60' },
		{ instrument: 'BTC-PERPETUAL', resolution: '1D' },
		{ instrument: 'ETH-PERPETUAL', resolution: '60' },
		{ instrument: 'ETH-PERPETUAL', resolution: '1D' },
		{ instrument: 'btc_usd', resolution: '1D' },
		{ instrument: 'eth_usd', resolution: '1D' },
		{ instrument: 'btc_dvol', resolution: '60' },
		{ instrument: 'btc_dvol', resolution: '1D' },
		{ instrument: 'eth_dvol', resolution: '60' },
		{ instrument: 'eth_dvol', resolution: '1D' },
	];

/** Startup backfill: 1D only for all 6 series. Hourly fills in once the app is live. */
const BACKFILL_INSTRUMENTS: { instrument: string; resolution: string }[] = [
	{ instrument: 'BTC-PERPETUAL', resolution: '1D' },
	{ instrument: 'ETH-PERPETUAL', resolution: '1D' },
	{ instrument: 'btc_usd', resolution: '1D' },
	{ instrument: 'eth_usd', resolution: '1D' },
	{ instrument: 'btc_dvol', resolution: '1D' },
	{ instrument: 'eth_dvol', resolution: '1D' },
];

/** Earliest date with useful data across all series (btc_dvol from 2021-03, eth_dvol from 2021-09). */
const BACKFILL_START = new Date('2021-01-01');

/** Max candle range per resolution to stay within Deribit API limits. */
const MAX_RANGE_MS: Record<string, number> = {
	'1': 7 * 86_400_000,
	'3': 7 * 86_400_000,
	'5': 14 * 86_400_000,
	'10': 14 * 86_400_000,
	'15': 30 * 86_400_000,
	'30': 30 * 86_400_000,
	'60': 60 * 86_400_000,
	'120': 90 * 86_400_000,
	'180': 90 * 86_400_000,
	'360': 180 * 86_400_000,
	'720': 365 * 86_400_000,
	'1D': 730 * 86_400_000,
	'1W': 1825 * 86_400_000,
};

const DERIBIT_PUBLIC_REST = 'https://www.deribit.com/api/v2/public';

const DVOL_INSTRUMENTS = new Set(['btc_dvol', 'eth_dvol']);
const SPOT_INSTRUMENTS = new Set(['btc_usd', 'eth_usd']);
const DVOL_RES: Record<string, string> = {
	'60': '3600',
	'360': '21600',
	'1D': '86400',
	'1W': '604800',
};

@Injectable()
export class DataIngestionService implements OnModuleInit {
	private readonly logger = new Logger(DataIngestionService.name);
	private client: DeribitApiClient;

	constructor(private readonly prisma: PrismaService) {
		this.client = createDeribitClientPublic();
	}

	// ---------------------------------------------------------------------------
	// Lifecycle: auto-backfill on startup
	// ---------------------------------------------------------------------------

	async onModuleInit() {
		// Fire-and-forget — don't block application startup
		this.runInitialBackfillIfNeeded().catch((err) =>
			this.logger.error(`Initial backfill error: ${err.message}`),
		);
	}

	private async runInitialBackfillIfNeeded() {
		for (const { instrument, resolution } of BACKFILL_INSTRUMENTS) {
			const count = await this.prisma.candle.count({
				where: { instrument, resolution },
			});
			if (count === 0) {
				this.logger.log(
					`No candles for ${instrument}@${resolution} — backfilling from ${BACKFILL_START.toISOString().slice(0, 10)}`,
				);
				const result = await this.backfillCandles({
					instrument,
					resolution,
					from: BACKFILL_START,
				});
				this.logger.log(
					`Initial backfill done: ${instrument}@${resolution} → ${result.inserted} candles`,
				);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Candle ingestion (uses Deribit public REST, not WebSocket client)
	// ---------------------------------------------------------------------------

	/**
	 * Backfill OHLCV candles for a given instrument and resolution.
	 * Routes to the correct Deribit endpoint:
	 *   - btc_usd / eth_usd  → get_delivery_prices (paginated, 1D only)
	 *   - btc_dvol / eth_dvol → get_volatility_index_data (chunked)
	 *   - everything else    → get_tradingview_chart_data (chunked)
	 */
	async backfillCandles(dto: BackfillDto): Promise<BackfillResult> {
		const toTs = (dto.to ?? new Date()).getTime();
		const fromTs = dto.from.getTime();

		// Spot index: single paginated fetch, no chunking
		if (SPOT_INSTRUMENTS.has(dto.instrument)) {
			const data = await this.fetchDeliveryPrices(
				dto.instrument,
				fromTs,
				toTs,
			);
			let inserted = 0,
				skipped = 0;
			if (data) {
				for (let i = 0; i < data.ticks.length; i++) {
					const timestamp = new Date(data.ticks[i]);
					try {
						await this.prisma.candle.upsert({
							where: {
								instrument_resolution_timestamp: {
									instrument: dto.instrument,
									resolution: dto.resolution,
									timestamp,
								},
							},
							update: {},
							create: {
								instrument: dto.instrument,
								resolution: dto.resolution,
								timestamp,
								open: data.open[i],
								high: data.high[i],
								low: data.low[i],
								close: data.close[i],
								volume: 0,
							},
						});
						inserted++;
					} catch {
						skipped++;
					}
				}
			}
			this.logger.log(
				`Backfill complete: ${dto.instrument}@${dto.resolution} — ${inserted} inserted, ${skipped} skipped`,
			);
			return {
				instrument: dto.instrument,
				resolution: dto.resolution,
				inserted,
				skipped,
				fromTs,
				toTs,
			};
		}

		// DVOL and TradingView: chunked fetch
		const maxRange = MAX_RANGE_MS[dto.resolution] ?? 60 * 86_400_000;
		const isDvol = DVOL_INSTRUMENTS.has(dto.instrument);
		let inserted = 0,
			skipped = 0,
			cursor = fromTs;

		while (cursor < toTs) {
			const chunkEnd = Math.min(cursor + maxRange, toTs);

			const data = isDvol
				? await this.fetchDvolChunk(
						dto.instrument,
						dto.resolution,
						cursor,
						chunkEnd,
					)
				: await this.fetchChartData(
						dto.instrument,
						dto.resolution,
						cursor,
						chunkEnd,
					);

			if (data?.ticks?.length) {
				const { ticks, open, high, low, close, volume } = data;
				for (let i = 0; i < ticks.length; i++) {
					const timestamp = new Date(ticks[i]);
					try {
						await this.prisma.candle.upsert({
							where: {
								instrument_resolution_timestamp: {
									instrument: dto.instrument,
									resolution: dto.resolution,
									timestamp,
								},
							},
							update: {},
							create: {
								instrument: dto.instrument,
								resolution: dto.resolution,
								timestamp,
								open: open[i],
								high: high[i],
								low: low[i],
								close: close[i],
								volume: volume?.[i] ?? 0,
							},
						});
						inserted++;
					} catch {
						skipped++;
					}
				}
				this.logger.debug(
					`Candle chunk [${dto.instrument} ${dto.resolution}] ` +
						`${new Date(cursor).toISOString().slice(0, 10)} → ${new Date(chunkEnd).toISOString().slice(0, 10)}: ` +
						`+${data.ticks.length} rows`,
				);
			}

			cursor = chunkEnd;
		}

		this.logger.log(
			`Backfill complete: ${dto.instrument}@${dto.resolution} — ${inserted} inserted, ${skipped} skipped`,
		);
		return {
			instrument: dto.instrument,
			resolution: dto.resolution,
			inserted,
			skipped,
			fromTs,
			toTs,
		};
	}

	/**
	 * Append candles since the last stored timestamp.
	 * Called by the scheduler every hour for each tracked instrument.
	 */
	async ingestLatestCandles(
		instrument: string,
		resolution: string,
	): Promise<number> {
		const latest = await this.prisma.candle.findFirst({
			where: { instrument, resolution },
			orderBy: { timestamp: 'desc' },
		});

		const from = latest
			? new Date(latest.timestamp.getTime() + 1)
			: new Date(Date.now() - 30 * 86_400_000);

		const result = await this.backfillCandles({
			instrument,
			resolution,
			from,
		});
		return result.inserted;
	}

	/** Ingest latest candles for all tracked instruments. Called by the scheduler. */
	async ingestAllTracked(): Promise<
		{ instrument: string; resolution: string; inserted: number }[]
	> {
		const results: {
			instrument: string;
			resolution: string;
			inserted: number;
		}[] = [];
		for (const { instrument, resolution } of TRACKED_INSTRUMENTS) {
			const inserted = await this.ingestLatestCandles(
				instrument,
				resolution,
			);
			results.push({ instrument, resolution, inserted });
		}
		return results;
	}

	/** Query stored candles with optional time range. */
	async queryCandles(
		instrument: string,
		resolution: string,
		from?: Date,
		to?: Date,
		limit = 1000,
	) {
		return this.prisma.candle.findMany({
			where: {
				instrument,
				resolution,
				...(from || to
					? {
							timestamp: {
								...(from ? { gte: from } : {}),
								...(to ? { lte: to } : {}),
							},
						}
					: {}),
			},
			orderBy: { timestamp: 'asc' },
			take: limit,
		});
	}

	// ---------------------------------------------------------------------------
	// Options chain snapshot (uses deribit-api-client WebSocket for instrument list,
	// then direct REST for per-instrument tickers)
	// ---------------------------------------------------------------------------

	/**
	 * Snapshot the full options IV surface for a currency.
	 * Fetches mark prices, IVs, and greeks for all active option instruments.
	 */
	async snapshotOptionChain(
		currency: 'BTC' | 'ETH',
	): Promise<OptionSnapshotResult> {
		// Use REST instead of the WebSocket client — the WS connection goes stale
		// between hourly calls and rejects with non-Error objects.
		const instrUrl = new URL(`${DERIBIT_PUBLIC_REST}/get_instruments`);
		instrUrl.searchParams.set('currency', currency);
		instrUrl.searchParams.set('kind', 'option');
		instrUrl.searchParams.set('expired', 'false');

		const instrRes = await fetch(instrUrl.toString(), {
			signal: AbortSignal.timeout(30_000),
		});
		if (!instrRes.ok) {
			this.logger.warn(
				`get_instruments failed for ${currency}: HTTP ${instrRes.status}`,
			);
			return { currency, captured: 0, errors: 1 };
		}
		const instrJson = (await instrRes.json()) as any;
		if (!Array.isArray(instrJson.result)) {
			return { currency, captured: 0, errors: 1 };
		}

		const activeInstruments = (instrJson.result as any[])
			.filter((i) => i.is_active)
			.map((i) => i.instrument_name as string);

		const capturedAt = new Date();
		let captured = 0;
		let errors = 0;

		// Fetch tickers in batches via REST to avoid hammering the API
		const BATCH = 20;
		for (let i = 0; i < activeInstruments.length; i += BATCH) {
			const batch = activeInstruments.slice(i, i + BATCH);

			const tickers = await Promise.allSettled(
				batch.map((name) => this.fetchTicker(name)),
			);

			for (let j = 0; j < tickers.length; j++) {
				const res = tickers[j];
				const name = batch[j];

				if (res.status !== 'fulfilled' || !res.value) {
					errors++;
					continue;
				}

				const t = res.value;
				const parts = name.split('-'); // BTC-28MAR25-70000-C
				if (parts.length < 4) {
					errors++;
					continue;
				}

				const expiry = parts[1];
				const strike = parseFloat(parts[2]);
				const optionType =
					parts[3].toLowerCase() === 'c' ? 'call' : 'put';

				try {
					await this.prisma.optionSnapshot.create({
						data: {
							capturedAt,
							instrument: name,
							currency,
							expiry,
							strike,
							optionType,
							markIv: t.mark_iv ?? undefined,
							bidIv: t.bid_iv ?? undefined,
							askIv: t.ask_iv ?? undefined,
							markPrice: t.mark_price ?? undefined,
							bidPrice: t.best_bid_price ?? undefined,
							askPrice: t.best_ask_price ?? undefined,
							underlyingPrice: t.underlying_price ?? undefined,
							delta: t.greeks?.delta ?? undefined,
							gamma: t.greeks?.gamma ?? undefined,
							theta: t.greeks?.theta ?? undefined,
							vega: t.greeks?.vega ?? undefined,
							rho: t.greeks?.rho ?? undefined,
							openInterest: t.open_interest ?? undefined,
							volume24h: t.stats?.volume ?? undefined,
						},
					});
					captured++;
				} catch (err) {
					this.logger.warn(
						`Failed to save snapshot for ${name}: ${err.message}`,
					);
					errors++;
				}
			}
		}

		this.logger.log(
			`Option snapshot [${currency}]: ${captured} rows, ${errors} errors`,
		);
		return { currency, captured, errors };
	}

	/** Query stored option snapshots. */
	async queryOptionSnapshots(
		currency: string,
		expiry?: string,
		from?: Date,
		to?: Date,
		limit = 500,
	) {
		return this.prisma.optionSnapshot.findMany({
			where: {
				currency,
				...(expiry ? { expiry } : {}),
				...(from || to
					? {
							capturedAt: {
								...(from ? { gte: from } : {}),
								...(to ? { lte: to } : {}),
							},
						}
					: {}),
			},
			orderBy: [
				{ expiry: 'asc' },
				{ strike: 'asc' },
				{ capturedAt: 'desc' },
			],
			take: limit,
		});
	}

	// ---------------------------------------------------------------------------
	// Stats
	// ---------------------------------------------------------------------------

	async getCandleStats() {
		const rows = await this.prisma.$queryRaw<
			{
				instrument: string;
				resolution: string;
				count: bigint;
				min_ts: Date;
				max_ts: Date;
			}[]
		>`
      SELECT instrument, resolution,
             COUNT(*)       AS count,
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
			to: r.max_ts,
		}));
	}

	async getOptionSnapshotStats() {
		const rows = await this.prisma.$queryRaw<
			{ currency: string; count: bigint; min_ts: Date; max_ts: Date }[]
		>`
      SELECT currency,
             COUNT(*)          AS count,
             MIN("capturedAt") AS min_ts,
             MAX("capturedAt") AS max_ts
      FROM "OptionSnapshot"
      GROUP BY currency
    `;
		return rows.map((r) => ({
			currency: r.currency,
			count: Number(r.count),
			from: r.min_ts,
			to: r.max_ts,
		}));
	}

	// ---------------------------------------------------------------------------
	// Private: direct REST helpers
	// ---------------------------------------------------------------------------

	/**
	 * Fetch OHLCV chart data from Deribit's public REST API.
	 * The WebSocket client does not expose this endpoint, so we use fetch directly.
	 */
	private async fetchChartData(
		instrument: string,
		resolution: string,
		startTs: number,
		endTs: number,
	): Promise<{
		ticks: number[];
		open: number[];
		high: number[];
		low: number[];
		close: number[];
		volume?: number[];
	} | null> {
		const url = new URL(
			`${DERIBIT_PUBLIC_REST}/get_tradingview_chart_data`,
		);
		url.searchParams.set('instrument_name', instrument);
		url.searchParams.set('start_timestamp', String(startTs));
		url.searchParams.set('end_timestamp', String(endTs));
		url.searchParams.set('resolution', resolution);

		try {
			const res = await fetch(url.toString(), {
				signal: AbortSignal.timeout(30_000),
			});
			if (!res.ok) return null;
			const json = (await res.json()) as any;
			if (!json.result?.ticks?.length) return null;
			return json.result;
		} catch (err) {
			this.logger.warn(
				`fetchChartData failed for ${instrument}@${resolution}: ${err.message}`,
			);
			return null;
		}
	}

	private async fetchDvolChunk(
		instrument: string,
		resolution: string,
		startTs: number,
		endTs: number,
	): Promise<{
		ticks: number[];
		open: number[];
		high: number[];
		low: number[];
		close: number[];
		volume: number[];
	} | null> {
		const currency = instrument.startsWith('btc') ? 'BTC' : 'ETH';
		const dvolRes = DVOL_RES[resolution] ?? '86400';

		const url = new URL(`${DERIBIT_PUBLIC_REST}/get_volatility_index_data`);
		url.searchParams.set('currency', currency);
		url.searchParams.set('start_timestamp', String(startTs));
		url.searchParams.set('end_timestamp', String(endTs));
		url.searchParams.set('resolution', dvolRes);

		try {
			const res = await fetch(url.toString(), {
				signal: AbortSignal.timeout(30_000),
			});
			if (!res.ok) return null;
			const json = (await res.json()) as any;
			if (!json.result?.data?.length) return null;
			const rows: [number, number, number, number, number][] =
				json.result.data;
			return {
				ticks: rows.map((r) => r[0]),
				open: rows.map((r) => r[1]),
				high: rows.map((r) => r[2]),
				low: rows.map((r) => r[3]),
				close: rows.map((r) => r[4]),
				volume: rows.map(() => 0),
			};
		} catch (err) {
			this.logger.warn(
				`fetchDvolChunk failed for ${instrument}@${resolution}: ${err.message}`,
			);
			return null;
		}
	}

	private async fetchDeliveryPrices(
		instrument: string,
		fromTs: number,
		toTs: number,
	): Promise<{
		ticks: number[];
		open: number[];
		high: number[];
		low: number[];
		close: number[];
		volume: number[];
	} | null> {
		const allRows: { date: string; delivery_price: number }[] = [];
		let offset = 0;
		const PAGE = 10;

		while (true) {
			const url = new URL(`${DERIBIT_PUBLIC_REST}/get_delivery_prices`);
			url.searchParams.set('index_name', instrument);
			url.searchParams.set('offset', String(offset));
			url.searchParams.set('count', String(PAGE));

			try {
				const res = await fetch(url.toString(), {
					signal: AbortSignal.timeout(30_000),
				});
				if (!res.ok) break;
				const json = (await res.json()) as any;
				if (!json.result?.data?.length) break;

				const page: { date: string; delivery_price: number }[] =
					json.result.data;
				allRows.push(...page);

				const oldest = new Date(
					page[page.length - 1].date + 'T08:00:00Z',
				).getTime();
				if (oldest <= fromTs || page.length < PAGE) break;

				offset += PAGE;
				await new Promise((r) => setTimeout(r, 150));
			} catch (err) {
				this.logger.warn(
					`fetchDeliveryPrices page failed for ${instrument}: ${err.message}`,
				);
				break;
			}
		}

		if (!allRows.length) return null;

		const inRange = allRows
			.filter((r) => {
				const ts = new Date(r.date + 'T08:00:00Z').getTime();
				return ts >= fromTs && ts <= toTs;
			})
			.reverse();

		if (!inRange.length) return null;

		const ticks = inRange.map((r) =>
			new Date(r.date + 'T08:00:00Z').getTime(),
		);
		const price = inRange.map((r) => r.delivery_price);
		return {
			ticks,
			open: price,
			high: price,
			low: price,
			close: price,
			volume: price.map(() => 0),
		};
	}

	/** Fetch a single option ticker from Deribit's public REST API. */
	private async fetchTicker(instrumentName: string): Promise<any | null> {
		const url = new URL(`${DERIBIT_PUBLIC_REST}/get_ticker`);
		url.searchParams.set('instrument_name', instrumentName);

		try {
			const res = await fetch(url.toString(), {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return null;
			const json = (await res.json()) as any;
			return json.result ?? null;
		} catch {
			return null;
		}
	}
}
