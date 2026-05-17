import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
	createDeribitClientPublic,
	DeribitApiClient,
} from '@wrytes/deribit-api-client';
import { PrismaService } from '../../core/database/prisma.service';

export interface OptionChainSummary {
	currency: string;
	expiry: string; // e.g. '28MAR25'
	expiryTimestamp: number;
	actualDte: number;
	atm: number; // ATM strike
	nearbyStrikes: Array<{ strike: number; call?: string; put?: string }>;
}

const CACHE_TTL_MS = 30_000; // 30s for live prices
const DVOL_RESOLUTION = '86400'; // daily candles
const IV_RANK_DAYS = 365;

export interface MarketConditions {
	currency: string;
	indexPrice: number; // USD
	dvolIndex: number | null; // Deribit Vol Index (≈ IV)
	rv30d: number | null; // 30-day realized vol, annualised 0–1
	ivRank: number | null; // 0–100
	ivPercentile: number | null; // 0–100
	ivOverRv: number | null; // DVOL / (rv30d * 100) ratio — > 1 means IV > RV (premium elevated)
	markIv: number | null; // perpetual mark implied volatility
	timestamp: Date;
}

@Injectable()
export class MarketDataService implements OnModuleInit {
	private readonly logger = new Logger(MarketDataService.name);
	private client: DeribitApiClient;

	// Simple in-memory cache
	private readonly cache = new Map<
		string,
		{ value: any; expiresAt: number }
	>();

	constructor(private readonly prisma: PrismaService) {}

	onModuleInit() {
		this.client = createDeribitClientPublic();
		this.logger.log('MarketDataService: public Deribit client created');
	}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	async getIndexPrice(currency: 'BTC' | 'ETH'): Promise<number> {
		const key = `index_${currency}`;
		const cached = this.fromCache<number>(key);
		if (cached !== null) return cached;

		const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';
		const res = await this.client.market.getIndexPrice({
			index_name: indexName,
		});

		if (!('result' in res)) {
			throw new Error(`Failed to get index price for ${currency}`);
		}

		const price = res.result.index_price;
		this.toCache(key, price, CACHE_TTL_MS);
		return price;
	}

	async getCurrentConditions(
		currency: 'BTC' | 'ETH' = 'BTC',
	): Promise<MarketConditions> {
		const key = `conditions_${currency}`;
		const cached = this.fromCache<MarketConditions>(key);
		if (cached !== null) return cached;

		const perpInstrument =
			currency === 'BTC' ? 'BTC-PERPETUAL' : 'ETH-PERPETUAL';

		const [indexPrice, dvolData, markIvResult] = await Promise.allSettled([
			this.getIndexPrice(currency),
			this.fetchDvolHistory(currency, IV_RANK_DAYS),
			this.fetchPerpMarkIv(perpInstrument),
		]);

		const price = indexPrice.status === 'fulfilled' ? indexPrice.value : 0;
		const dvol = dvolData.status === 'fulfilled' ? dvolData.value : [];
		const markIv =
			markIvResult.status === 'fulfilled' ? markIvResult.value : null;

		const currentDvol = dvol.length > 0 ? dvol[dvol.length - 1] : null;
		const ivRank = dvol.length > 10 ? this.computeIvRank(dvol) : null;
		const ivPercentile =
			dvol.length > 10 ? this.computeIvPercentile(dvol) : null;
		const rv30d = dvol.length >= 30 ? this.computeRv30d(dvol) : null;

		const ivOverRv =
			currentDvol !== null && rv30d !== null && rv30d > 0
				? parseFloat((currentDvol / 100 / rv30d).toFixed(2))
				: null;

		const conditions: MarketConditions = {
			currency,
			indexPrice: price,
			dvolIndex: currentDvol,
			rv30d,
			ivRank,
			ivPercentile,
			ivOverRv,
			markIv,
			timestamp: new Date(),
		};

		this.toCache(key, conditions, CACHE_TTL_MS);
		return conditions;
	}

	async getAllConditions(): Promise<MarketConditions[]> {
		const [btc, eth] = await Promise.allSettled([
			this.getCurrentConditions('BTC'),
			this.getCurrentConditions('ETH'),
		]);
		return [
			btc.status === 'fulfilled'
				? btc.value
				: this.emptyConditions('BTC'),
			eth.status === 'fulfilled'
				? eth.value
				: this.emptyConditions('ETH'),
		];
	}

	/**
	 * Fetch the option chain for the nearest expiry matching targetDteDays.
	 * Returns the expiry date, actual DTE, ATM strike, and nearby strikes ±20%.
	 */
	async getOptionChain(
		currency: 'BTC' | 'ETH',
		targetDteDays: number,
		currentPrice: number,
	): Promise<OptionChainSummary | null> {
		const key = `optchain_${currency}_${targetDteDays}`;
		const cached = this.fromCache<OptionChainSummary>(key);
		if (cached !== null) return cached;

		const res = await this.client.market.getInstruments({
			currency,
			kind: 'option',
			expired: false,
		});

		if (!('result' in res) || !Array.isArray(res.result)) return null;

		const now = Date.now();
		const targetMs = targetDteDays * 86_400_000;

		// Group by expiry, find the one whose DTE is closest to target
		const expiries = new Map<number, typeof res.result>();
		for (const inst of res.result) {
			if (!inst.is_active) continue;
			const bucket = expiries.get(inst.expiration_timestamp) ?? [];
			bucket.push(inst);
			expiries.set(inst.expiration_timestamp, bucket);
		}

		let bestExpiry = 0;
		let bestDiff = Infinity;
		for (const ts of expiries.keys()) {
			const dte = (ts - now) / 86_400_000;
			if (dte < 1) continue; // skip expired/today
			const diff = Math.abs(dte - targetDteDays);
			if (diff < bestDiff) {
				bestDiff = diff;
				bestExpiry = ts;
			}
		}

		if (!bestExpiry) return null;

		const instruments = expiries.get(bestExpiry)!;
		const actualDte = Math.round((bestExpiry - now) / 86_400_000);

		// Parse expiry label from first instrument name (e.g. BTC-28MAR25-70000-C → 28MAR25)
		const expiryLabel = instruments[0].instrument_name.split('-')[1] ?? '';

		// Collect strikes within ±25% of current price
		const lowerBound = currentPrice * 0.75;
		const upperBound = currentPrice * 1.25;

		const strikesMap = new Map<number, { call?: string; put?: string }>();

		for (const inst of instruments) {
			const strike = inst.strike;
			if (!strike || strike < lowerBound || strike > upperBound) continue;
			const entry = strikesMap.get(strike) ?? {};
			if (inst.option_type === 'call') entry.call = inst.instrument_name;
			if (inst.option_type === 'put') entry.put = inst.instrument_name;
			strikesMap.set(strike, entry);
		}

		// ATM = nearest strike to current price
		let atm = 0;
		let atmDiff = Infinity;
		for (const strike of strikesMap.keys()) {
			const d = Math.abs(strike - currentPrice);
			if (d < atmDiff) {
				atmDiff = d;
				atm = strike;
			}
		}

		const nearbyStrikes = Array.from(strikesMap.entries())
			.sort(([a], [b]) => a - b)
			.map(([strike, v]) => ({ strike, call: v.call, put: v.put }));

		const summary: OptionChainSummary = {
			currency,
			expiry: expiryLabel,
			expiryTimestamp: bestExpiry,
			actualDte,
			atm,
			nearbyStrikes,
		};

		this.toCache(key, summary, 5 * 60_000); // cache 5 min
		return summary;
	}

	/** Persist a market snapshot for historical IV rank tracking. */
	async saveSnapshot(conditions: MarketConditions): Promise<void> {
		await this.prisma.marketSnapshot.create({
			data: {
				currency: conditions.currency,
				indexPrice: conditions.indexPrice,
				dvolIndex: conditions.dvolIndex ?? undefined,
				rv30d: conditions.rv30d ?? undefined,
				ivRank: conditions.ivRank ?? undefined,
				ivPercentile: conditions.ivPercentile ?? undefined,
				markIv: conditions.markIv ?? undefined,
			},
		});
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private async fetchDvolHistory(
		currency: string,
		days: number,
	): Promise<number[]> {
		const key = `dvol_${currency}_${days}`;
		const cached = this.fromCache<number[]>(key);
		if (cached !== null) return cached;

		const endTs = Date.now();
		const startTs = endTs - days * 86_400_000;

		const res = await this.client.market.getVolatilityIndexData({
			currency,
			start_timestamp: startTs,
			end_timestamp: endTs,
			resolution: DVOL_RESOLUTION,
		});

		if (!('result' in res)) return [];

		// Each candle: [timestamp, open, high, low, close] — use close
		const closes = res.result.data.map((c) => c[4]);
		this.toCache(key, closes, 10 * 60_000); // cache 10 min
		return closes;
	}

	/** IV Rank: (current − 52w_min) / (52w_max − 52w_min) × 100 */
	private computeIvRank(closes: number[]): number {
		const current = closes[closes.length - 1];
		const min = Math.min(...closes);
		const max = Math.max(...closes);
		if (max === min) return 50;
		return parseFloat((((current - min) / (max - min)) * 100).toFixed(1));
	}

	/** IV Percentile: % of days where DVOL was below current value */
	private computeIvPercentile(closes: number[]): number {
		const current = closes[closes.length - 1];
		const below = closes.filter((v) => v < current).length;
		return parseFloat(((below / closes.length) * 100).toFixed(1));
	}

	/**
	 * 30-day realized volatility (annualised).
	 * Uses daily log returns of DVOL closes as a proxy; in production
	 * you'd use index price history for true RV.
	 */
	private computeRv30d(closes: number[]): number {
		const window = closes.slice(-31);
		if (window.length < 2) return 0;
		const logReturns: number[] = [];
		for (let i = 1; i < window.length; i++) {
			if (window[i - 1] > 0)
				logReturns.push(Math.log(window[i] / window[i - 1]));
		}
		const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
		const variance =
			logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
			logReturns.length;
		const annualisedVol = Math.sqrt(variance * 365);
		return parseFloat(annualisedVol.toFixed(4));
	}

	private fromCache<T>(key: string): T | null {
		const entry = this.cache.get(key);
		if (entry && entry.expiresAt > Date.now()) return entry.value as T;
		return null;
	}

	private toCache(key: string, value: any, ttlMs: number) {
		this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
	}

	private async fetchPerpMarkIv(instrument: string): Promise<number | null> {
		const key = `markiv_${instrument}`;
		const cached = this.fromCache<number>(key);
		if (cached !== null) return cached;

		const url = new URL('https://www.deribit.com/api/v2/public/get_ticker');
		url.searchParams.set('instrument_name', instrument);

		try {
			const res = await fetch(url.toString(), {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return null;
			const json = (await res.json()) as any;
			const iv = json.result?.mark_iv ?? null;
			if (iv !== null) this.toCache(key, iv, CACHE_TTL_MS);
			return iv;
		} catch {
			return null;
		}
	}

	private emptyConditions(currency: string): MarketConditions {
		return {
			currency,
			indexPrice: 0,
			dvolIndex: null,
			rv30d: null,
			ivRank: null,
			ivPercentile: null,
			ivOverRv: null,
			markIv: null,
			timestamp: new Date(),
		};
	}
}
