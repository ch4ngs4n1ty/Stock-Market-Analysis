import axios from 'axios';
import { fetchAlphaVantageDailyCandles } from './alphavantage';
import { CompanyFundamentals, fetchFmpDailyCandles } from './fmp';
import { fetchYahooDailyCandles } from './yahoo';

const http = axios.create({
  baseURL: 'https://finnhub.io/api/v1',
  timeout: 10_000,
});

function isAxiosStatus(error: unknown, status: number): boolean {
  return axios.isAxiosError(error) && error.response?.status === status;
}

function apiKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY is not set in environment');
  return key;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export interface QuoteData {
  currentPrice: number | null;
  dailyPercentChange: number | null;
  previousClose: number | null;
  timestamp: number | null;
}

export interface CandleData {
  close: number[];
  high: number[];
  low: number[];
  open: number[];
  timestamps: number[];
  volume: number[];
  warning?: string;
  source?: 'finnhub' | 'fmp' | 'yahoo' | 'alpha_vantage';
}

export interface IndicatorData {
  rsi: number | null;
  warning?: string;
  source?: 'finnhub' | 'local';
}

export interface NewsHeadline {
  headline: string;
  source: string | null;
  url: string | null;
  datetime: number | null;
  summary: string | null;
}

export async function fetchQuote(symbol: string): Promise<QuoteData> {
  const { data } = await http.get('/quote', {
    params: { symbol, token: apiKey() },
  });

  return {
    currentPrice: data?.c ?? null,
    dailyPercentChange: data?.dp ?? null,
    previousClose: data?.pc ?? null,
    timestamp: data?.t ?? null,
  };
}

export async function fetchDailyCandles(symbol: string, lookbackDays = 100): Promise<CandleData> {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);

  let data: Record<string, unknown>;
  try {
    const response = await http.get('/stock/candle', {
      params: {
        symbol,
        resolution: 'D',
        from: unixSeconds(from),
        to: unixSeconds(to),
        token: apiKey(),
      },
    });
    data = response.data;
  } catch (error) {
    if (isAxiosStatus(error, 403)) {
      // Fallback chain: Yahoo (unkeyed, works for any ticker) → FMP (works for
      // mega-caps on free tier) → Alpha Vantage (last resort, very limited).
      const yahooCandles = await fetchYahooDailyCandles(symbol);
      if (yahooCandles) {
        return { ...yahooCandles, source: 'yahoo' as const };
      }
      const fmpCandles = await fetchFmpDailyCandles(symbol);
      if (fmpCandles) {
        return { ...fmpCandles, source: 'fmp' as const };
      }
      const fallbackCandles = await fetchAlphaVantageDailyCandles(symbol);
      return {
        ...fallbackCandles,
        warning: [
          'Finnhub, FMP, and Yahoo all returned no candle data; falling back to Alpha Vantage.',
          fallbackCandles.warning,
        ].filter(Boolean).join(' '),
      };
    }
    throw error;
  }

  if (data?.s !== 'ok') {
    return { close: [], high: [], low: [], open: [], timestamps: [], volume: [] };
  }

  return {
    close: Array.isArray(data.c) ? data.c as number[] : [],
    high: Array.isArray(data.h) ? data.h as number[] : [],
    low: Array.isArray(data.l) ? data.l as number[] : [],
    open: Array.isArray(data.o) ? data.o as number[] : [],
    timestamps: Array.isArray(data.t) ? data.t as number[] : [],
    volume: Array.isArray(data.v) ? data.v as number[] : [],
    source: 'finnhub',
  };
}

export async function fetchRsi(symbol: string, lookbackDays = 100): Promise<IndicatorData> {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);

  try {
    const { data } = await http.get('/indicator', {
      params: {
        symbol,
        resolution: 'D',
        from: unixSeconds(from),
        to: unixSeconds(to),
        indicator: 'rsi',
        timeperiod: 14,
        token: apiKey(),
      },
    });

    const values = Array.isArray(data?.rsi) ? data.rsi : [];
    const latest = [...values].reverse().find((value) => typeof value === 'number');

    return { rsi: latest ?? null, source: 'finnhub' };
  } catch (error) {
    if (isAxiosStatus(error, 403)) {
      return {
        rsi: null,
        warning: 'Finnhub denied access to /indicator?indicator=rsi for this API key.',
      };
    }
    throw error;
  }
}

export async function fetchCompanyNews(symbol: string, lookbackDays = 14): Promise<NewsHeadline[]> {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);

  let data: unknown;
  try {
    const response = await http.get('/company-news', {
      params: {
        symbol,
        from: formatDate(from),
        to: formatDate(to),
        token: apiKey(),
      },
    });
    data = response.data;
  } catch (error) {
    if (isAxiosStatus(error, 403)) return [];
    throw error;
  }

  if (!Array.isArray(data)) return [];

  return data
    .map((item) => ({
      headline: item.headline ?? '',
      source: item.source ?? null,
      url: item.url ?? null,
      datetime: item.datetime ?? null,
      summary: item.summary ?? null,
    }))
    .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
    .slice(0, 10);
}

function pickMetric(metric: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = metric[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// Manual PEG = P/E ÷ growth %  (per-spec: an EPS Growth of 25 means PEG = PE / 25).
// Rejects nonsensical inputs so we never fabricate a PEG: P/E must be positive
// and finite, growth must be at least MIN_GROWTH_PCT (negative or near-zero
// growth produces meaningless / explosive PEG values).
const MIN_GROWTH_PCT = 1;
const MAX_PEG = 99;

interface PegResolution {
  value: number | null;
  source: 'api' | 'calculated' | null;
  method: string | null;
}

function calculatePeg(peRatio: number | null, growthPct: number | null): number | null {
  if (peRatio === null || !Number.isFinite(peRatio) || peRatio <= 0) return null;
  if (growthPct === null || !Number.isFinite(growthPct) || growthPct < MIN_GROWTH_PCT) return null;
  const peg = peRatio / growthPct;
  if (!Number.isFinite(peg) || peg <= 0 || peg > MAX_PEG) return null;
  return Math.round(peg * 100) / 100;
}

// Fallback chain follows the user spec:
//   API PEG (vendor-provided ratio) →
//   manual calc with growth, in this priority:
//     1. 5Y EPS CAGR     — most stable historical EPS growth
//     2. 3Y EPS CAGR     — shorter window if 5Y is missing
//     3. TTM EPS YoY     — recent realized growth (proxy for "projected")
//     4. 5Y revenue CAGR — last-resort growth proxy
//     5. TTM revenue YoY — last-resort recent growth proxy
//   null if nothing usable (do NOT fabricate)
function resolvePeg(metric: Record<string, unknown>, peRatio: number | null): PegResolution {
  // Vendor-provided PEG values, in order of preference.
  const apiPeg = pickMetric(metric, 'pegTTM', 'forwardPEG', 'pegRatio', 'pegRatioTTM', 'pegRatio5Y');
  if (apiPeg !== null) {
    return { value: apiPeg, source: 'api', method: 'Finnhub API' };
  }

  const candidates: Array<{ key: string; label: string }> = [
    { key: 'epsGrowth5Y', label: '5Y EPS CAGR' },
    { key: 'epsGrowth3Y', label: '3Y EPS CAGR' },
    { key: 'epsGrowthTTMYoy', label: 'TTM EPS YoY' },
    { key: 'revenueGrowth5Y', label: '5Y revenue CAGR' },
    { key: 'revenueGrowthTTMYoy', label: 'TTM revenue YoY' },
  ];

  for (const c of candidates) {
    const growth = pickMetric(metric, c.key);
    const peg = calculatePeg(peRatio, growth);
    if (peg !== null) {
      return { value: peg, source: 'calculated', method: c.label };
    }
  }

  return { value: null, source: null, method: null };
}

/**
 * Fundamentals via Finnhub /stock/metric. Works for any US ticker on the free tier
 * (FMP free tier denies most non-mega-caps with 402, which broke discovery scans).
 * Returns the same CompanyFundamentals shape so the scoring pipeline is unchanged.
 *
 * Field mapping notes:
 *  - peTTM, pegRatio: trailing twelve months / annual ratios
 *  - roeTTM: percent (Finnhub returns it pre-multiplied, e.g. 35.5 = 35.5%)
 *  - pbAnnual: most recent annual book value
 *  - totalDebt/totalEquityAnnual: classic D/E
 */
export async function fetchCompanyFundamentals(symbol: string): Promise<CompanyFundamentals> {
  let data: Record<string, unknown>;
  try {
    const response = await http.get('/stock/metric', {
      params: { symbol, metric: 'all', token: apiKey() },
    });
    data = response.data ?? {};
  } catch (error) {
    if (isAxiosStatus(error, 401) || isAxiosStatus(error, 403)) {
      return {
        peRatio: null, pegRatio: null, pegSource: null, pegMethod: null,
        roe: null, pbRatio: null, deRatio: null,
        warning: 'Finnhub denied access to /stock/metric for this API key.',
        source: 'unavailable',
      };
    }
    throw error;
  }

  const metric = (data?.metric && typeof data.metric === 'object')
    ? data.metric as Record<string, unknown>
    : {};

  const peRatio = pickMetric(metric, 'peTTM', 'peBasicExclExtraTTM', 'peNormalizedAnnual', 'peAnnual');
  // PEG: try API first, then manual calculation per user spec. resolvePeg never
  // fabricates — if no usable growth metric exists, returns null with source=null.
  const peg = resolvePeg(metric, peRatio);

  return {
    peRatio,
    pegRatio: peg.value,
    pegSource: peg.source,
    pegMethod: peg.method,
    roe: pickMetric(metric, 'roeTTM', 'roeRfy', 'roeAnnual'),
    pbRatio: pickMetric(metric, 'pbAnnual', 'pbQuarterly', 'priceToBookAnnual'),
    deRatio: pickMetric(
      metric,
      'totalDebt/totalEquityAnnual',
      'totalDebt/totalEquityQuarterly',
      'longTermDebt/equityAnnual',
      'longTermDebt/equityQuarterly',
    ),
    source: 'finnhub',
  };
}
