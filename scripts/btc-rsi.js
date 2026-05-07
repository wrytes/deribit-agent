const WARMUP = 100; // candles before the period to stabilize Wilder's smoothing

function calculateRSI(closes, period = 14) {
  if (closes.length < period + WARMUP) {
    throw new Error(`Need at least ${period + WARMUP} candles, got ${closes.length}`);
  }

  // Seed with simple average over first period
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function fetchCandles(resolution, count) {
  const now = Date.now();
  const msPerCandle = resolution === '1D'
    ? 24 * 60 * 60 * 1000
    : resolution * 60 * 1000;

  const from = now - count * msPerCandle;

  const url = new URL('https://www.deribit.com/api/v2/public/get_tradingview_chart_data');
  url.searchParams.set('instrument_name', 'BTC-PERPETUAL');
  url.searchParams.set('start_timestamp', from);
  url.searchParams.set('end_timestamp', now);
  url.searchParams.set('resolution', resolution);

  const res = await fetch(url);
  const json = await res.json();
  if (!json.result) throw new Error(`API error: ${JSON.stringify(json)}`);
  return json.result;
}

async function getDeribitRSI(resolution, period = 14) {
  const candlesNeeded = period + WARMUP + 1;
  const result = await fetchCandles(resolution, candlesNeeded);
  return calculateRSI(result.close, period);
}

async function getDeribitWeeklyRSI(period = 14) {
  // Fetch 7x daily candles, then aggregate into weekly closes
  const candlesNeeded = (period + WARMUP + 1) * 7;
  const result = await fetchCandles('1D', candlesNeeded);

  const closes = [];
  for (let i = 6; i < result.close.length; i += 7) {
    closes.push(result.close[i]); // last close of each 7-day window
  }

  return calculateRSI(closes, period);
}

async function main() {
  const [rsi1h, rsi6h, rsi1d, rsi1w] = await Promise.all([
    getDeribitRSI(60),
    getDeribitRSI(360),
    getDeribitRSI('1D'),
    getDeribitWeeklyRSI(),
  ]);

  console.log(`BTC RSI (1h):  ${rsi1h.toFixed(2)}`);
  console.log(`BTC RSI (6h):  ${rsi6h.toFixed(2)}`);
  console.log(`BTC RSI (1d):  ${rsi1d.toFixed(2)}`);
  console.log(`BTC RSI (1w):  ${rsi1w.toFixed(2)}`);
}

main();
