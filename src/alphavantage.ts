import axios from 'axios';
import type { CandleData } from './finnhub';

const alphaHttp = axios.create({
  baseURL: 'https://www.alphavantage.co',
  timeout: 25_000,
});

// Alpha Vantage free tier is 5 req/min. When several scan workers hit the fallback
// in parallel we serialize them so AV doesn't time out everything.
let avChain: Promise<unknown> = Promise.resolve();
function avSerialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = avChain.catch(() => undefined).then(fn);
  avChain = next.catch(() => undefined);
  return next;
}

function alphaVantageApiKey(): string | null {
  return process.env.ALPHA_VANTAGE_API_KEY ?? null;
}

function dateToUnixSeconds(date: string): number | null {
  const time = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.floor(time / 1000);
}

function emptyCandles(warning?: string): CandleData {
  return {
    close: [],
    high: [],
    low: [],
    open: [],
    timestamps: [],
    volume: [],
    warning,
    source: 'alpha_vantage',
  };
}

export async function fetchAlphaVantageDailyCandles(symbol: string, limit = 120): Promise<CandleData> {
  const apiKey = alphaVantageApiKey();
  if (!apiKey) {
    return emptyCandles('Alpha Vantage fallback requires ALPHA_VANTAGE_API_KEY in the environment.');
  }

  let data: Record<string, unknown>;
  try {
    const response = await avSerialize(() => alphaHttp.get('/query', {
      params: {
        function: 'TIME_SERIES_DAILY',
        symbol,
        outputsize: 'compact',
        apikey: apiKey,
      },
    }));
    data = response.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return emptyCandles(`Alpha Vantage request failed: ${message}`);
  }

  if (typeof data?.Note === 'string') {
    return emptyCandles(`Alpha Vantage rate limit: ${data.Note}`);
  }

  if (typeof data?.Information === 'string') {
    return emptyCandles(`Alpha Vantage message: ${data.Information}`);
  }

  if (typeof data?.['Error Message'] === 'string') {
    return emptyCandles(`Alpha Vantage error: ${data['Error Message']}`);
  }

  const series = data?.['Time Series (Daily)'];
  if (!series || typeof series !== 'object') {
    return emptyCandles('Alpha Vantage returned an unexpected daily candle format.');
  }

  const candles = Object.entries(series as Record<string, Record<string, string>>)
    .map(([date, row]) => ({
      timestamp: dateToUnixSeconds(date),
      open: Number(row['1. open']),
      high: Number(row['2. high']),
      low: Number(row['3. low']),
      close: Number(row['4. close']),
      volume: Number(row['5. volume']),
    }))
    .filter((item) =>
      item.timestamp !== null
      && Number.isFinite(item.open)
      && Number.isFinite(item.high)
      && Number.isFinite(item.low)
      && Number.isFinite(item.close),
    )
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
    .slice(-limit);

  if (!candles.length) return emptyCandles('Alpha Vantage returned no usable daily candles.');

  return {
    close: candles.map((item) => item.close),
    high: candles.map((item) => item.high),
    low: candles.map((item) => item.low),
    open: candles.map((item) => item.open),
    timestamps: candles.map((item) => item.timestamp as number),
    volume: candles.map((item) => (Number.isFinite(item.volume) ? item.volume : 0)),
    source: 'alpha_vantage',
  };
}
