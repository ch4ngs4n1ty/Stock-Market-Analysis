import axios from 'axios';

// Yahoo Finance's chart endpoint is unkeyed and returns full OHLC for any US ticker.
// We use it as the candle source since:
//   - Finnhub free tier denies /stock/candle (403)
//   - FMP free tier denies /historical-price-eod for non-mega-cap symbols (402)
//   - Alpha Vantage free tier dropped to 25 req/day (effectively unusable for scans)
// Yahoo has no per-key throttle for reasonable use; we still send a desktop UA so
// the endpoint doesn't reply with an HTML challenge page.

const yahooHttp = axios.create({
  baseURL: 'https://query1.finance.yahoo.com',
  timeout: 10_000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockResearchScanner/1.0)' },
});

export interface YahooDailyCandles {
  close: number[];
  high: number[];
  low: number[];
  open: number[];
  timestamps: number[];
  volume: number[];
}

export async function fetchYahooDailyCandles(symbol: string, range = '3mo'): Promise<YahooDailyCandles | null> {
  let raw: unknown;
  try {
    const res = await yahooHttp.get(`/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      params: { range, interval: '1d' },
    });
    raw = res.data;
  } catch {
    return null;
  }

  const result = (raw as { chart?: { result?: Array<Record<string, unknown>> } })
    ?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp as number[] : [];
  const indicators = result.indicators as { quote?: Array<Record<string, unknown>> } | undefined;
  const quote = indicators?.quote?.[0];
  if (!quote) return null;

  const open = Array.isArray(quote.open) ? quote.open as Array<number | null> : [];
  const high = Array.isArray(quote.high) ? quote.high as Array<number | null> : [];
  const low = Array.isArray(quote.low) ? quote.low as Array<number | null> : [];
  const close = Array.isArray(quote.close) ? quote.close as Array<number | null> : [];
  const volume = Array.isArray(quote.volume) ? quote.volume as Array<number | null> : [];

  // Yahoo occasionally returns null entries for non-trading days — drop those rows.
  const cleaned = timestamps
    .map((ts, i) => ({
      ts,
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i],
      volume: volume[i] ?? 0,
    }))
    .filter((row) =>
      typeof row.ts === 'number'
      && typeof row.open === 'number'
      && typeof row.high === 'number'
      && typeof row.low === 'number'
      && typeof row.close === 'number',
    );

  if (!cleaned.length) return null;

  return {
    open: cleaned.map((r) => r.open as number),
    high: cleaned.map((r) => r.high as number),
    low: cleaned.map((r) => r.low as number),
    close: cleaned.map((r) => r.close as number),
    timestamps: cleaned.map((r) => r.ts),
    volume: cleaned.map((r) => (typeof r.volume === 'number' ? r.volume : 0)),
  };
}
