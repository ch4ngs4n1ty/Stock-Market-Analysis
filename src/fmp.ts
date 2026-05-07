import axios from 'axios';

// Primary fundamentals source. Finnhub stays for realtime quote + news only.
// Add new fields here as future metrics (revenue growth, FCF, EPS growth, etc.)
// are wired in — every consumer treats null as "data unavailable".
export interface CompanyFundamentals {
  peRatio: number | null;
  pegRatio: number | null;
  // Where the PEG value came from. 'api' = vendor-provided ratio (Finnhub pegTTM /
  // forwardPEG, FMP pegRatioTTM). 'calculated' = manually derived as P/E ÷ growth %
  // when no API PEG was available. null when PEG could not be obtained at all.
  pegSource: 'api' | 'calculated' | null;
  // Which growth series produced the calculated PEG (e.g. '5Y EPS CAGR').
  // Helps the UI explain why the number is what it is, and lets the user know
  // when the PEG is built on a less-ideal proxy like revenue growth.
  pegMethod: string | null;
  roe: number | null;          // percent (e.g. 15 means 15%); FMP returns a decimal we normalize
  pbRatio: number | null;
  deRatio: number | null;
  warning?: string;
  source: 'fmp' | 'finnhub' | 'unavailable';
}

// Discovery candidate from FMP's biggest-losers endpoint. Used to dynamically
// build the scan watchlist instead of hardcoding tickers.
export interface MarketMover {
  symbol: string;
  name: string;
  price: number;
  exchange: string;
  changePercent: number;
}

// Daily OHLC candle from FMP. Same shape as the Finnhub CandleData consumer
// expects, so it slots into fetchDailyCandles' fallback chain unchanged.
export interface FmpDailyCandles {
  close: number[];
  high: number[];
  low: number[];
  open: number[];
  timestamps: number[];
  volume: number[];
}

// FMP migrated to a /stable/ API on 2025-08-31; the legacy /api/v3/ paths now 403.
const fmpHttp = axios.create({
  baseURL: 'https://financialmodelingprep.com/stable',
  timeout: 10_000,
});

function apiKey(): string | null {
  return process.env.FMP_API_KEY ?? null;
}

function isAxiosStatus(err: unknown, status: number): boolean {
  return axios.isAxiosError(err) && err.response?.status === status;
}

// One-shot retry on 429 (rate-limit). Anything else propagates.
async function getWithRetry<T>(
  path: string,
  params: Record<string, unknown>,
  attempts = 2,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fmpHttp.get<T>(path, { params });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (isAxiosStatus(err, 429) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function unavailable(warning: string): CompanyFundamentals {
  return {
    peRatio: null,
    pegRatio: null,
    pegSource: null,
    pegMethod: null,
    roe: null,
    pbRatio: null,
    deRatio: null,
    warning,
    source: 'unavailable',
  };
}

function firstRow(raw: unknown): Record<string, unknown> | null {
  return Array.isArray(raw) && raw.length > 0
    && typeof raw[0] === 'object' && raw[0] !== null
      ? (raw[0] as Record<string, unknown>)
      : null;
}

// FMP TTM endpoints classify a 401/403 as "no access on this tier" — we surface a
// helpful warning rather than throwing so a single 403 doesn't kill the whole scan.
function denialMessage(endpoint: string): string {
  return `FMP denied access to ${endpoint} — this symbol may not be in your plan's supported set, or the endpoint requires a higher tier.`;
}

/**
 * Fetches the 5 quality metrics from FMP's stable TTM endpoints.
 * - /ratios-ttm: P/E, PEG, P/B, D/E
 * - /key-metrics-ttm: ROE (as decimal, normalized to percent here)
 *
 * Returns each field as a typed number-or-null so callers can render "Data unavailable"
 * without the score being unfairly penalized. Both endpoints are hit in parallel.
 */
export async function fetchCompanyFundamentals(symbol: string): Promise<CompanyFundamentals> {
  const key = apiKey();
  if (!key) {
    return unavailable('FMP_API_KEY is not set; fundamentals are unavailable.');
  }

  const params = { symbol, apikey: key };

  const ratiosPromise = getWithRetry<unknown>('/ratios-ttm', params).catch((err) => {
    if (isAxiosStatus(err, 401) || isAxiosStatus(err, 402) || isAxiosStatus(err, 403)) {
      return { __unavailable: denialMessage('/ratios-ttm') };
    }
    if (isAxiosStatus(err, 429)) {
      return { __unavailable: 'FMP rate limit hit on /ratios-ttm.' };
    }
    throw err;
  });

  const keyMetricsPromise = getWithRetry<unknown>('/key-metrics-ttm', params).catch((err) => {
    if (isAxiosStatus(err, 401) || isAxiosStatus(err, 402) || isAxiosStatus(err, 403)) {
      return { __unavailable: denialMessage('/key-metrics-ttm') };
    }
    if (isAxiosStatus(err, 429)) {
      return { __unavailable: 'FMP rate limit hit on /key-metrics-ttm.' };
    }
    throw err;
  });

  const [ratiosRaw, keyMetricsRaw] = await Promise.all([ratiosPromise, keyMetricsPromise]);

  const warnings: string[] = [];
  const ratiosRow = (ratiosRaw && typeof ratiosRaw === 'object' && '__unavailable' in ratiosRaw)
    ? (warnings.push((ratiosRaw as { __unavailable: string }).__unavailable), null)
    : firstRow(ratiosRaw);

  const keyMetricsRow = (keyMetricsRaw && typeof keyMetricsRaw === 'object' && '__unavailable' in keyMetricsRaw)
    ? (warnings.push((keyMetricsRaw as { __unavailable: string }).__unavailable), null)
    : firstRow(keyMetricsRaw);

  // Both endpoints failed → fully unavailable, single combined warning.
  if (!ratiosRow && !keyMetricsRow) {
    return unavailable(warnings.join(' ') || 'FMP returned no fundamentals for this ticker.');
  }

  // FMP TTM ROE is a decimal (0.15 = 15%); the rest of the system uses percent.
  const roeDecimal = keyMetricsRow
    ? pickNumber(keyMetricsRow, 'returnOnEquityTTM')
    : null;
  const roePercent = roeDecimal === null ? null : roeDecimal * 100;

  const fmpPeg = ratiosRow
    ? pickNumber(ratiosRow, 'priceToEarningsGrowthRatioTTM', 'forwardPriceToEarningsGrowthRatioTTM')
    : null;

  return {
    peRatio: ratiosRow ? pickNumber(ratiosRow, 'priceToEarningsRatioTTM') : null,
    pegRatio: fmpPeg,
    pegSource: fmpPeg !== null ? 'api' : null,
    pegMethod: fmpPeg !== null ? 'FMP TTM' : null,
    roe: roePercent,
    pbRatio: ratiosRow ? pickNumber(ratiosRow, 'priceToBookRatioTTM') : null,
    deRatio: ratiosRow ? pickNumber(ratiosRow, 'debtToEquityRatioTTM') : null,
    warning: warnings.length ? warnings.join(' ') : undefined,
    source: 'fmp',
  };
}

// Lightweight S&P 500 member metadata used by the discovery filter and sector tags.
export interface Sp500Constituent {
  symbol: string;
  name: string;
  sector: string;
}

/**
 * Returns the current S&P 500 constituent list. Free FMP tier returns all 500+
 * members in a single call (no per-symbol gating like the fundamentals endpoints
 * have). The index changes ~quarterly so the caller should cache aggressively.
 */
export async function fetchSp500Constituents(): Promise<Sp500Constituent[]> {
  const key = apiKey();
  if (!key) return [];

  let raw: unknown;
  try {
    raw = await getWithRetry<unknown>('/sp500-constituent', { apikey: key });
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map((row): Sp500Constituent | null => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const symbol = typeof r.symbol === 'string' ? r.symbol : null;
      if (!symbol) return null;
      return {
        symbol,
        name: typeof r.name === 'string' ? r.name : '',
        sector: typeof r.sector === 'string' ? r.sector : '',
      };
    })
    .filter((c): c is Sp500Constituent => c !== null);
}

/**
 * Pulls today's biggest losers from FMP. Used as the seed for dynamic
 * watchlist discovery. Returns [] on any error so the caller can fall back
 * gracefully (e.g. to a curated list) rather than failing the whole scan.
 */
export async function fetchBiggestLosers(): Promise<MarketMover[]> {
  const key = apiKey();
  if (!key) return [];

  let raw: unknown;
  try {
    raw = await getWithRetry<unknown>('/biggest-losers', { apikey: key });
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map((row): MarketMover | null => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const symbol = typeof r.symbol === 'string' ? r.symbol : null;
      const price = typeof r.price === 'number' ? r.price : null;
      const name = typeof r.name === 'string' ? r.name : '';
      const exchange = typeof r.exchange === 'string' ? r.exchange : '';
      const changePercent = typeof r.changesPercentage === 'number' ? r.changesPercentage : null;
      if (!symbol || price === null || changePercent === null) return null;
      return { symbol, name, price, exchange, changePercent };
    })
    .filter((m): m is MarketMover => m !== null);
}

/**
 * Daily OHLC from FMP — replaces the Alpha Vantage candle fallback. AV's free
 * tier is 5 req/min (a real bottleneck for multi-ticker scans); FMP has none of
 * that throttling for this endpoint. Returns null on failure so the caller can
 * try another source.
 */
export async function fetchFmpDailyCandles(symbol: string, limit = 120): Promise<FmpDailyCandles | null> {
  const key = apiKey();
  if (!key) return null;

  let raw: unknown;
  try {
    raw = await getWithRetry<unknown>('/historical-price-eod/full', { symbol, apikey: key });
  } catch {
    return null;
  }

  if (!Array.isArray(raw) || raw.length === 0) return null;

  // FMP returns newest-first; we want oldest-first to match the rest of the system.
  const rows = (raw as Record<string, unknown>[])
    .map((r) => ({
      date: typeof r.date === 'string' ? r.date : null,
      open: typeof r.open === 'number' ? r.open : null,
      high: typeof r.high === 'number' ? r.high : null,
      low: typeof r.low === 'number' ? r.low : null,
      close: typeof r.close === 'number' ? r.close : null,
      volume: typeof r.volume === 'number' ? r.volume : 0,
    }))
    .filter((r) => r.date && r.close !== null && r.high !== null && r.low !== null && r.open !== null)
    .sort((a, b) => (a.date! < b.date! ? -1 : 1))
    .slice(-limit);

  if (!rows.length) return null;

  return {
    close: rows.map((r) => r.close as number),
    high: rows.map((r) => r.high as number),
    low: rows.map((r) => r.low as number),
    open: rows.map((r) => r.open as number),
    timestamps: rows.map((r) => Math.floor(new Date(`${r.date}T00:00:00Z`).getTime() / 1000)),
    volume: rows.map((r) => r.volume),
  };
}
