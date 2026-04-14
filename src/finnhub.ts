import axios from 'axios';

const http = axios.create({
  baseURL: 'https://finnhub.io/api/v1',
  timeout: 10_000,
});

function apiKey(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY is not set in environment');
  return k;
}

// ── Price data (cached 30 s) ──────────────────────────────────────────────────

export interface PriceData {
  price: number | null;
  changePct: number | null;
  volume: number | null;
}

export async function fetchPrice(symbol: string): Promise<PriceData> {
  const { data: q } = await http.get('/quote', {
    params: { symbol, token: apiKey() },
  });

  const price = q.c ?? null;
  const prevClose = q.pc ?? null;

  return {
    price,
    changePct:
      price != null && prevClose != null && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : null,
    volume: q.v ?? null,
  };
}

// ── Metric data (cached 24 h) ─────────────────────────────────────────────────

export interface MetricData {
  avgVolume10d: number | null;
  high52w: number | null;
  low52w: number | null;
  ma50d: number | null;
  ma200d: number | null;
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  freeCashFlow: number | null;
}

export async function fetchMetrics(symbol: string): Promise<MetricData> {
  const { data } = await http.get('/stock/metric', {
    params: { symbol, metric: 'all', token: apiKey() },
  });

  const m = data?.metric ?? {};

  // Finnhub reports average trading volume in millions of shares
  const avgVol10d =
    m['10DayAverageTradingVolume'] != null
      ? m['10DayAverageTradingVolume'] * 1_000_000
      : null;

  return {
    avgVolume10d: avgVol10d,
    high52w: m['52WeekHigh'] ?? null,
    low52w: m['52WeekLow'] ?? null,
    ma50d: m['50DayMovingAverage'] ?? null,
    ma200d: m['200DayMovingAverage'] ?? null,
    revenueGrowthYoy: m.revenueGrowthTTMYoy ?? null,
    epsGrowthYoy: m.epsGrowthTTMYoy ?? null,
    grossMargin: m.grossMarginTTM ?? null,
    operatingMargin: m.operatingMarginTTM ?? null,
    netMargin: m.netProfitMarginTTM ?? null,
    roe: m.roeTTM ?? null,
    debtToEquity: m.totalDebt_totalEquityAnnual ?? null,
    currentRatio: m.currentRatioAnnual ?? null,
    freeCashFlow: m.freeCashFlowTTM ?? null,
  };
}
