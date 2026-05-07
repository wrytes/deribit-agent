#!/usr/bin/env node
/**
 * scripts/backfill.js
 *
 * Seeds the Candle table with historical OHLCV data from Deribit.
 *
 * Three API endpoints used:
 *   - get_tradingview_chart_data  → perpetual futures (BTC/ETH-PERPETUAL)
 *   - get_volatility_index_data   → DVOL index (btc_dvol / eth_dvol)
 *   - get_delivery_prices         → spot index daily prices (btc_usd / eth_usd)
 *
 * Spot index is stored at 1D resolution only (Deribit provides daily settlement
 * prices via get_delivery_prices). Hourly spot is proxied by BTC-PERPETUAL.
 *
 * Usage:
 *   node scripts/backfill.js                              # 4 years, all defaults
 *   node scripts/backfill.js --from 2022-01-01
 *   node scripts/backfill.js --instrument BTC-PERPETUAL --resolution 1D --from 2020-01-01
 *   node scripts/backfill.js --instrument btc_dvol --resolution 1D --from 2021-01-01
 *   node scripts/backfill.js --instrument btc_usd --resolution 1D --from 2020-01-01
 *
 * Reads DATABASE_URL from .env automatically.
 */

const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Endpoints & routing
// ---------------------------------------------------------------------------
const CANDLE_API   = 'https://www.deribit.com/api/v2/public/get_tradingview_chart_data';
const DVOL_API     = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const DELIVERY_API = 'https://www.deribit.com/api/v2/public/get_delivery_prices';

// Routed to get_volatility_index_data
const DVOL_INSTRUMENTS = new Set(['btc_dvol', 'eth_dvol']);

// Routed to get_delivery_prices (daily settlement = spot index, 1D only)
const SPOT_INSTRUMENTS = new Set(['btc_usd', 'eth_usd']);

// DVOL resolution in seconds (our notation → Deribit seconds)
const DVOL_RES = { '60': '3600', '360': '21600', '1D': '86400', '1W': '604800' };

// Max time window per TradingView request
const MAX_RANGE_MS = {
	'1':   7   * 86_400_000,
	'3':   7   * 86_400_000,
	'5':   14  * 86_400_000,
	'10':  14  * 86_400_000,
	'15':  30  * 86_400_000,
	'30':  30  * 86_400_000,
	'60':  60  * 86_400_000,
	'120': 90  * 86_400_000,
	'180': 90  * 86_400_000,
	'360': 180 * 86_400_000,
	'720': 365 * 86_400_000,
	'1D':  730 * 86_400_000,
	'1W': 1825 * 86_400_000,
};

const DEFAULT_FROM = new Date(Date.now() - 4 * 365 * 86_400_000);
const DEFAULT_TO   = new Date();

const DEFAULT_JOBS = [
	// Perpetuals — price + volume, primary training series
	{ instrument: 'BTC-PERPETUAL', resolution: '1D' },
	{ instrument: 'BTC-PERPETUAL', resolution: '60' },
	{ instrument: 'ETH-PERPETUAL', resolution: '1D' },
	{ instrument: 'ETH-PERPETUAL', resolution: '60' },
	// Spot index — daily settlement price; used to derive basis vs perpetual
	// (basis annualised = implied risk-free rate for the options model)
	{ instrument: 'btc_usd',       resolution: '1D' },
	{ instrument: 'eth_usd',       resolution: '1D' },
	// DVOL — BTC/ETH VIX equivalent; BTC from 2021-03, ETH from 2021-09
	{ instrument: 'btc_dvol',      resolution: '1D' },
	{ instrument: 'btc_dvol',      resolution: '60' },
	{ instrument: 'eth_dvol',      resolution: '1D' },
	{ instrument: 'eth_dvol',      resolution: '60' },
];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const fromDate   = flag('--from') ? new Date(flag('--from')) : DEFAULT_FROM;
const toDate     = flag('--to')   ? new Date(flag('--to'))   : DEFAULT_TO;
const instrument = flag('--instrument');
const resolution = flag('--resolution');
const DEBUG      = args.includes('--debug');
const jobs       = (instrument && resolution) ? [{ instrument, resolution }] : DEFAULT_JOBS;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
function loadEnv() {
	const envPath = path.join(__dirname, '..', '.env');
	if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
		for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
			const m = line.match(/^DATABASE_URL=(.+)/);
			if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
		}
	}
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchCandleChunk(instrument, resolution, startTs, endTs) {
	const url = new URL(CANDLE_API);
	url.searchParams.set('instrument_name', instrument);
	url.searchParams.set('start_timestamp', startTs);
	url.searchParams.set('end_timestamp',   endTs);
	url.searchParams.set('resolution',      resolution);

	const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
	const json = await res.json();
	if (DEBUG && !json.result?.ticks?.length)
		console.error(`  [debug] raw =`, JSON.stringify(json).slice(0, 300));
	if (!json.result?.ticks?.length) return null;

	const { ticks, open, high, low, close, volume } = json.result;
	return { ticks, open, high, low, close, volume: volume ?? ticks.map(() => 0) };
}

async function fetchDvolChunk(instrument, resolution, startTs, endTs) {
	const currency = instrument.startsWith('btc') ? 'BTC' : 'ETH';
	const dvolRes  = DVOL_RES[resolution] ?? '86400';

	const url = new URL(DVOL_API);
	url.searchParams.set('currency',        currency);
	url.searchParams.set('start_timestamp', startTs);
	url.searchParams.set('end_timestamp',   endTs);
	url.searchParams.set('resolution',      dvolRes);

	const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
	const json = await res.json();
	if (!json.result?.data?.length) return null;

	const rows = json.result.data; // [[ts, open, high, low, close], ...]
	return {
		ticks:  rows.map(r => r[0]),
		open:   rows.map(r => r[1]),
		high:   rows.map(r => r[2]),
		low:    rows.map(r => r[3]),
		close:  rows.map(r => r[4]),
		volume: rows.map(() => 0),
	};
}

/**
 * Fetch all delivery (settlement) prices for a spot index via pagination.
 * Returns canonical ticks/OHLCV shape — open=high=low=close=settlement price.
 * Results are newest-first from the API, so we reverse before returning.
 *
 * Deribit caps count at 10 per request; we paginate until we have all records
 * or go past the fromTs boundary.
 */
async function fetchDeliveryPrices(instrument, fromTs, toTs) {
	const indexName = instrument; // 'btc_usd' or 'eth_usd'
	const allRows   = [];
	let   offset    = 0;
	const PAGE      = 10;

	while (true) {
		const url = new URL(DELIVERY_API);
		url.searchParams.set('index_name', indexName);
		url.searchParams.set('offset',     offset);
		url.searchParams.set('count',      PAGE);

		const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
		const json = await res.json();

		if (DEBUG) console.error(`  [debug delivery] offset=${offset}`, JSON.stringify(json).slice(0, 300));
		if (!json.result?.data?.length) break;

		const page = json.result.data; // [{ date: "2024-12-27", delivery_price: 94823.59 }, ...]
		allRows.push(...page);

		// Rows are newest-first; stop when oldest row in this page is before fromTs
		const oldest = new Date(page[page.length - 1].date + 'T08:00:00Z').getTime();
		if (oldest <= fromTs || page.length < PAGE) break;

		offset += PAGE;
		await new Promise(r => setTimeout(r, 150));
	}

	if (!allRows.length) return null;

	// Filter to requested range and reverse to chronological order
	const inRange = allRows
		.filter(r => {
			const ts = new Date(r.date + 'T08:00:00Z').getTime();
			return ts >= fromTs && ts <= toTs;
		})
		.reverse();

	if (!inRange.length) return null;

	const ticks = inRange.map(r => new Date(r.date + 'T08:00:00Z').getTime());
	const price = inRange.map(r => r.delivery_price);
	return { ticks, open: price, high: price, low: price, close: price, volume: price.map(() => 0) };
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------
async function upsertCandles(client, instrument, resolution, data) {
	const { ticks, open, high, low, close, volume } = data;
	let inserted = 0, skipped = 0;

	for (let i = 0; i < ticks.length; i++) {
		const ts = new Date(ticks[i]).toISOString();
		try {
			const result = await client.query(
				`INSERT INTO "Candle" (id, instrument, resolution, timestamp, open, high, low, close, volume, source)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'deribit')
         ON CONFLICT (instrument, resolution, timestamp) DO NOTHING`,
				[instrument, resolution, ts, open[i], high[i], low[i], close[i], volume[i] ?? 0],
			);
			if (result.rowCount > 0) inserted++; else skipped++;
		} catch { skipped++; }
	}
	return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Backfill one job
// ---------------------------------------------------------------------------
async function backfill(client, instrument, resolution, fromTs, toTs) {
	process.stdout.write(
		`\n[${instrument} ${resolution}]  ` +
		`${new Date(fromTs).toISOString().slice(0, 10)} → ${new Date(toTs).toISOString().slice(0, 10)}\n`,
	);

	let totalInserted = 0, totalSkipped = 0;

	// ---- Spot index: single paginated fetch, no chunking needed ----
	if (SPOT_INSTRUMENTS.has(instrument)) {
		if (resolution !== '1D') {
			console.log(`  Skipped: ${instrument} only available at 1D (Deribit delivery prices are daily)`);
			return 0;
		}
		const data = await fetchDeliveryPrices(instrument, fromTs, toTs);
		if (data) {
			const { inserted, skipped } = await upsertCandles(client, instrument, resolution, data);
			totalInserted = inserted;
			totalSkipped  = skipped;
		}
		console.log(`\n  Done: ${totalInserted} inserted, ${totalSkipped} skipped\n`);
		return totalInserted;
	}

	// ---- DVOL / Candle: chunked fetch ----
	const isDvol     = DVOL_INSTRUMENTS.has(instrument);
	const maxRange   = MAX_RANGE_MS[resolution] ?? 60 * 86_400_000;
	const fetchChunk = isDvol ? fetchDvolChunk : fetchCandleChunk;

	let cursor = fromTs, chunks = 0;

	while (cursor < toTs) {
		const chunkEnd = Math.min(cursor + maxRange, toTs);
		const data     = await fetchChunk(instrument, resolution, cursor, chunkEnd);

		if (data) {
			const { inserted, skipped } = await upsertCandles(client, instrument, resolution, data);
			totalInserted += inserted;
			totalSkipped  += skipped;
			chunks++;
			process.stdout.write(
				`  chunk ${chunks}: +${inserted} rows  (${new Date(cursor).toISOString().slice(0, 10)})\r`,
			);
		}

		cursor = chunkEnd;
		await new Promise(r => setTimeout(r, 100));
	}

	console.log(`\n  Done: ${totalInserted} inserted, ${totalSkipped} skipped\n`);
	return totalInserted;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
(async () => {
	loadEnv();
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL not set and not found in .env');
		process.exit(1);
	}

	console.log(`Backfill  ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
	console.log(`Jobs: ${jobs.map(j => `${j.instrument}@${j.resolution}`).join(', ')}\n`);

	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	for (const job of jobs) {
		await backfill(client, job.instrument, job.resolution, fromDate.getTime(), toDate.getTime());
	}

	await client.end();
	console.log('All done.');
})().catch(e => { console.error(e.message); process.exit(1); });
