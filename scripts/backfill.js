#!/usr/bin/env node
/**
 * scripts/backfill.js
 *
 * Seeds the Candle table with historical data directly from the Deribit REST API.
 * Bypasses the NestJS service — useful for one-time bulk loads.
 *
 * Usage:
 *   node scripts/backfill.js
 *   node scripts/backfill.js --from 2022-01-01 --to 2026-01-01
 *   node scripts/backfill.js --instrument BTC-PERPETUAL --resolution 1D --from 2020-01-01
 *
 * Env: DATABASE_URL must be set (reads from .env automatically)
 */

const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DERIBIT_REST = 'https://www.deribit.com/api/v2/public/get_tradingview_chart_data';

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

// Default: 4 years back
const DEFAULT_FROM = new Date(Date.now() - 4 * 365 * 86_400_000);
const DEFAULT_TO   = new Date();

const DEFAULT_JOBS = [
  { instrument: 'BTC-PERPETUAL', resolution: '1D' },
  { instrument: 'BTC-PERPETUAL', resolution: '60' },
  { instrument: 'ETH-PERPETUAL', resolution: '1D' },
  { instrument: 'ETH-PERPETUAL', resolution: '60' },
];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const fromDate  = get('--from')       ? new Date(get('--from'))       : DEFAULT_FROM;
const toDate    = get('--to')         ? new Date(get('--to'))         : DEFAULT_TO;
const instrument = get('--instrument');
const resolution = get('--resolution');
const jobs = (instrument && resolution)
  ? [{ instrument, resolution }]
  : DEFAULT_JOBS;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^DATABASE_URL=(.+)/);
      if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
async function fetchChunk(instrument, resolution, startTs, endTs) {
  const url = new URL(DERIBIT_REST);
  url.searchParams.set('instrument_name', instrument);
  url.searchParams.set('start_timestamp', startTs);
  url.searchParams.set('end_timestamp',   endTs);
  url.searchParams.set('resolution',      resolution);

  const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  const json = await res.json();
  if (!json.result?.ticks?.length) return null;
  return json.result;
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
        [instrument, resolution, ts, open[i], high[i], low[i], close[i], volume?.[i] ?? 0],
      );
      if (result.rowCount > 0) inserted++;
      else skipped++;
    } catch (e) {
      skipped++;
    }
  }
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function backfill(instrument, resolution, fromTs, toTs) {
  const maxRange = MAX_RANGE_MS[resolution] ?? 60 * 86_400_000;
  let cursor = fromTs;
  let totalInserted = 0, totalSkipped = 0, chunks = 0;

  loadEnv();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  process.stdout.write(`\n[${instrument} ${resolution}]  ${new Date(fromTs).toISOString().slice(0,10)} → ${new Date(toTs).toISOString().slice(0,10)}\n`);

  while (cursor < toTs) {
    const chunkEnd = Math.min(cursor + maxRange, toTs);
    const data = await fetchChunk(instrument, resolution, cursor, chunkEnd);

    if (data) {
      const { inserted, skipped } = await upsertCandles(client, instrument, resolution, data);
      totalInserted += inserted;
      totalSkipped  += skipped;
      chunks++;
      process.stdout.write(`  chunk ${chunks}: +${inserted} rows  (${new Date(cursor).toISOString().slice(0,10)})\r`);
    }

    cursor = chunkEnd;

    // Polite rate limiting — Deribit public API allows ~20 req/s
    await new Promise(r => setTimeout(r, 100));
  }

  await client.end();
  console.log(`\n  Done: ${totalInserted} inserted, ${totalSkipped} skipped\n`);
  return totalInserted;
}

(async () => {
  console.log(`Backfill  ${fromDate.toISOString().slice(0,10)} → ${toDate.toISOString().slice(0,10)}`);
  console.log(`Jobs: ${jobs.map(j => `${j.instrument}@${j.resolution}`).join(', ')}`);

  for (const job of jobs) {
    await backfill(job.instrument, job.resolution, fromDate.getTime(), toDate.getTime());
  }

  console.log('All done.');
})().catch(e => { console.error(e.message); process.exit(1); });
