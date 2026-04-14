export interface ScoreInput {
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  relativeVolume: number | null;
  distFrom52wHigh: number | null; // negative = below high (e.g. -10 = 10% below)
  price: number | null;
  ma200d: number | null;
}

export interface ScoreResult {
  composite: number;
  growth: number;
  profitability: number;
  leverage: number;
  momentum: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Weighted average of non-null components */
function wavg(components: Array<{ score: number | null; weight: number }>): number {
  const available = components.filter((c) => c.score !== null);
  if (!available.length) return 0;
  const totalW = available.reduce((s, c) => s + c.weight, 0);
  const sum = available.reduce((s, c) => s + c.score! * c.weight, 0);
  return sum / totalW;
}

// ── Sub-scores (0–1) ──────────────────────────────────────────────────────────

/**
 * Full score at ≥30% revenue growth and ≥30% EPS growth.
 */
function growthScore(d: ScoreInput): number {
  const rev = d.revenueGrowthYoy != null ? clamp01(d.revenueGrowthYoy / 0.30) : null;
  const eps = d.epsGrowthYoy != null ? clamp01(d.epsGrowthYoy / 0.30) : null;
  return wavg([
    { score: rev, weight: 0.60 },
    { score: eps, weight: 0.40 },
  ]);
}

/**
 * Benchmarks: gross margin 60%, operating margin 25%, net margin 20%, ROE 25%.
 */
function profitabilityScore(d: ScoreInput): number {
  return wavg([
    { score: d.grossMargin != null ? clamp01(d.grossMargin / 0.60) : null, weight: 0.30 },
    { score: d.operatingMargin != null ? clamp01(d.operatingMargin / 0.25) : null, weight: 0.30 },
    { score: d.netMargin != null ? clamp01(d.netMargin / 0.20) : null, weight: 0.20 },
    { score: d.roe != null ? clamp01(d.roe / 0.25) : null, weight: 0.20 },
  ]);
}

/**
 * Lower D/E and higher current ratio = higher score.
 * Falls back to neutral (0.5) when both are unavailable.
 */
function leverageScore(d: ScoreInput): number {
  const de = d.debtToEquity != null ? clamp01(1 - Math.max(0, d.debtToEquity) / 3.0) : null;
  const cr = d.currentRatio != null ? clamp01(d.currentRatio / 2.0) : null;

  if (de === null && cr === null) return 0.5;
  if (de === null) return cr!;
  if (cr === null) return de;
  return de * 0.60 + cr * 0.40;
}

/**
 * Relative volume ≥3×, at 52w high, price above 200-DMA.
 */
function momentumScore(d: ScoreInput): number {
  const rv = d.relativeVolume != null ? clamp01(d.relativeVolume / 3.0) : null;
  // distFrom52wHigh: 0 = at high, -30 = 30% below → map to [0,1]
  const d52 = d.distFrom52wHigh != null ? clamp01(1 + d.distFrom52wHigh / 30) : null;
  const above =
    d.price != null && d.ma200d != null ? (d.price > d.ma200d ? 1 : 0) : null;

  return wavg([
    { score: rv, weight: 0.20 },
    { score: d52, weight: 0.40 },
    { score: above, weight: 0.40 },
  ]);
}

// ── Composite ─────────────────────────────────────────────────────────────────

export function computeScore(d: ScoreInput): ScoreResult {
  const gs = growthScore(d);
  const ps = profitabilityScore(d);
  const ls = leverageScore(d);
  const ms = momentumScore(d);

  const composite = gs * 0.30 + ps * 0.35 + ls * 0.20 + ms * 0.15;

  return {
    composite: r1(composite * 100),
    growth: r1(gs * 100),
    profitability: r1(ps * 100),
    leverage: r1(ls * 100),
    momentum: r1(ms * 100),
  };
}
