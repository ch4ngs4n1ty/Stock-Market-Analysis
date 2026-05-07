import { CandleData, NewsHeadline, QuoteData } from './finnhub';
import { CompanyFundamentals } from './fmp';

export type DipLabel = 'GOOD DIP' | 'WATCH' | 'AVOID';
export type TrendDirection = 'UPTREND' | 'RECOVERING' | 'MIXED' | 'DOWNTREND' | 'UNKNOWN';

export type FundamentalLabel =
  | 'INSTANT BUY QUALITY'
  | 'STRONG QUALITY'
  | 'DECENT'
  | 'WEAK QUALITY'
  | 'AVOID QUALITY';

export type FinalRating =
  | 'INSTANT BUY'
  | 'STRONG BUY CANDIDATE'
  | 'GOOD DIP, BUT NEEDS MORE RESEARCH'
  | 'VALUE TRAP RISK'
  | 'GREAT COMPANY, BAD ENTRY'
  | 'AVOID'
  | 'HOLD / MIXED SIGNALS';

export interface FundamentalCheck {
  value: number | null;
  available: boolean;
  pass: boolean;
  threshold: string;
}

export interface FundamentalAnalysisResult {
  pe: FundamentalCheck;
  peg: FundamentalCheck;
  roe: FundamentalCheck;
  pb: FundamentalCheck;
  de: FundamentalCheck;
  // PEG provenance — UI uses this to flag when PEG was manually derived
  // (P/E ÷ growth %) rather than vendor-provided.
  pegSource: 'api' | 'calculated' | null;
  pegMethod: string | null;
  // score = number of passing checks; maxScore = total defined checks (always 5 today,
  // grows when new metrics are added). For label/ranking we use percent of *available*.
  score: number;
  maxScore: number;
  availableCount: number;
  missingCount: number;
  // Percent of *available* metrics that pass. Missing metrics do not penalize.
  // 0 when no metric is available.
  fundamentalPercent: number;
  label: FundamentalLabel;
  warning: string | null;
}

export interface CombinedRatingResult {
  rating: FinalRating;
  reasoning: string;
  warning: string | null;
}

export interface DipAnalysisInput {
  ticker: string;
  quote: QuoteData;
  candles: CandleData;
  rsi: number | null;
  news: NewsHeadline[];
  dataWarnings?: string[];
}

export interface DipAnalysisResult {
  ticker: string;
  currentPrice: number | null;
  dailyPercentChange: number | null;
  recentHigh: number | null;
  recentHighWindow: number | null;
  dipPercentage: number | null;
  sma20: number | null;
  sma50: number | null;
  trendDirection: TrendDirection;
  rsi: number | null;
  latestNewsHeadlines: NewsHeadline[];
  badNewsFlag: boolean;
  score: number;
  label: DipLabel;
  explanation: string;
  disclaimer: string;
  dataWarnings: string[];
}

const BAD_NEWS_TERMS = [
  'bankruptcy',
  'chapter 11',
  'fraud',
  'investigation',
  'sec probe',
  'lawsuit',
  'downgrade',
  'misses estimates',
  'weak guidance',
  'cuts guidance',
  'recall',
  'layoffs',
  'data breach',
  'halts production',
  'delisting',
];

function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  return average(values.slice(-window));
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;

  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < slice.length; i += 1) {
    const change = slice[i] - slice[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function recentHigh(highs: number[]): { high: number | null; window: number | null } {
  const window = highs.length >= 50 ? 50 : highs.length >= 20 ? 20 : highs.length;
  if (!window) return { high: null, window: null };
  return { high: Math.max(...highs.slice(-window)), window };
}

function detectBadNews(news: NewsHeadline[]): boolean {
  return news.some((item) => {
    const text = `${item.headline} ${item.summary ?? ''}`.toLowerCase();
    return BAD_NEWS_TERMS.some((term) => text.includes(term));
  });
}

function getTrendDirection(currentPrice: number | null, sma20Value: number | null, sma50Value: number | null): TrendDirection {
  if (currentPrice === null || sma50Value === null) return 'UNKNOWN';
  if (sma20Value !== null && currentPrice > sma50Value && sma20Value > sma50Value) return 'UPTREND';
  if (currentPrice > sma50Value) return 'RECOVERING';
  if (sma20Value !== null && currentPrice < sma50Value && sma20Value < sma50Value) return 'DOWNTREND';
  return 'MIXED';
}

function getLabel(score: number): DipLabel {
  if (score >= 75) return 'GOOD DIP';
  if (score >= 50) return 'WATCH';
  return 'AVOID';
}

function buildExplanation(result: {
  dipPercentage: number | null;
  trendDirection: TrendDirection;
  rsi: number | null;
  badNewsFlag: boolean;
  score: number;
  label: DipLabel;
}): string {
  const reasons: string[] = [];

  if (result.dipPercentage !== null) {
    reasons.push(
      result.dipPercentage > 5
        ? `Dip is ${round(result.dipPercentage)}% from the recent high.`
        : `Dip is only ${round(result.dipPercentage)}% from the recent high.`,
    );
  }

  if (result.trendDirection === 'UPTREND' || result.trendDirection === 'RECOVERING') {
    reasons.push(`Trend is ${result.trendDirection.toLowerCase()} because price is above SMA50.`);
  } else if (result.trendDirection !== 'UNKNOWN') {
    reasons.push(`Trend is ${result.trendDirection.toLowerCase()} relative to the moving averages.`);
  }

  if (result.rsi !== null) {
    reasons.push(result.rsi < 35 ? `RSI is low at ${round(result.rsi)}.` : `RSI is ${round(result.rsi)}, so it is not deeply oversold.`);
  }

  reasons.push(result.badNewsFlag ? 'Recent headlines include possible bad-news keywords.' : 'No obvious bad-news keyword was found in recent headlines.');
  reasons.push(`This is labeled ${result.label} as a research signal, not a buy recommendation.`);

  return reasons.join(' ');
}

export function analyzeDip(input: DipAnalysisInput): DipAnalysisResult {
  const latestNewsHeadlines = input.news.filter((item) => item.headline).slice(0, 3);
  const currentPrice = input.quote.currentPrice;
  const sma20Value = sma(input.candles.close, 20);
  const sma50Value = sma(input.candles.close, 50);
  const rsiValue = input.rsi ?? rsi(input.candles.close);
  const high = recentHigh(input.candles.high);
  const dipPercentage =
    currentPrice !== null && high.high !== null && high.high > 0
      ? ((high.high - currentPrice) / high.high) * 100
      : null;
  const trendDirection = getTrendDirection(currentPrice, sma20Value, sma50Value);
  const badNewsFlag = detectBadNews(latestNewsHeadlines);

  let score = 0;
  if (dipPercentage !== null && dipPercentage > 5) score += 30;
  if (currentPrice !== null && sma50Value !== null && currentPrice > sma50Value) score += 25;
  if (rsiValue !== null && rsiValue < 35) score += 20;
  if (!badNewsFlag) score += 25;

  const label = getLabel(score);
  const explanation = buildExplanation({
    dipPercentage,
    trendDirection,
    rsi: rsiValue,
    badNewsFlag,
    score,
    label,
  });

  return {
    ticker: input.ticker,
    currentPrice: round(currentPrice),
    dailyPercentChange: round(input.quote.dailyPercentChange),
    recentHigh: round(high.high),
    recentHighWindow: high.window,
    dipPercentage: round(dipPercentage),
    sma20: round(sma20Value),
    sma50: round(sma50Value),
    trendDirection,
    rsi: round(rsiValue),
    latestNewsHeadlines,
    badNewsFlag,
    score,
    label,
    explanation,
    disclaimer: 'Research signal only. This is not financial advice and does not predict that the stock will go up.',
    dataWarnings: [
      ...(input.dataWarnings ?? []),
      input.rsi === null && rsiValue !== null
        ? 'RSI computed locally from historical candle closes.'
        : null,
    ].filter((warning): warning is string => Boolean(warning)),
  };
}

function evaluate(
  value: number | null,
  threshold: string,
  predicate: (value: number) => boolean,
): FundamentalCheck {
  if (value === null) {
    return { value: null, available: false, pass: false, threshold };
  }
  return { value: round(value), available: true, pass: predicate(value), threshold };
}

// Bucket the percent of *available* metrics that pass into a quality tier.
// If 0 metrics are available we default to AVOID QUALITY (conservative + a warning is set).
function getFundamentalLabel(percent: number, availableCount: number): FundamentalLabel {
  if (availableCount === 0) return 'AVOID QUALITY';
  if (percent >= 100) return 'INSTANT BUY QUALITY';
  if (percent >= 80) return 'STRONG QUALITY';
  if (percent >= 60) return 'DECENT';
  if (percent >= 40) return 'WEAK QUALITY';
  return 'AVOID QUALITY';
}

export function analyzeFundamentals(input: CompanyFundamentals): FundamentalAnalysisResult {
  const pe = evaluate(input.peRatio, 'P/E < 20', (v) => v > 0 && v < 20);
  const peg = evaluate(input.pegRatio, 'PEG < 1', (v) => v > 0 && v < 1);
  const roe = evaluate(input.roe, 'ROE > 15%', (v) => v > 15);
  const pb = evaluate(input.pbRatio, 'P/B < 3', (v) => v > 0 && v < 3);
  const de = evaluate(input.deRatio, 'D/E < 1', (v) => v >= 0 && v < 1);

  // To add a new metric in the future: append it here, define its evaluate() rule,
  // and surface it in the UI/glossary. The percent calc handles arbitrary metric counts.
  const checks = [pe, peg, roe, pb, de];
  const score = checks.filter((c) => c.pass).length;
  const availableCount = checks.filter((c) => c.available).length;
  const missingCount = checks.length - availableCount;
  const fundamentalPercent = availableCount > 0
    ? Math.round((score / availableCount) * 100)
    : 0;

  return {
    pe,
    peg,
    roe,
    pb,
    de,
    pegSource: input.pegSource,
    pegMethod: input.pegMethod,
    score,
    maxScore: checks.length,
    availableCount,
    missingCount,
    fundamentalPercent,
    label: getFundamentalLabel(fundamentalPercent, availableCount),
    warning: input.warning ?? null,
  };
}

// Equal-weighted blend of timing and company quality, capped 0–100.
// Both inputs are already normalized to a percent, so this is a literal average × 2 ÷ 2.
export function combinedScore(
  dip: DipAnalysisResult,
  fundamentals: FundamentalAnalysisResult,
): number {
  const dipPart = (Math.max(0, Math.min(100, dip.score)) / 100) * 50;
  const fundPart = (Math.max(0, Math.min(100, fundamentals.fundamentalPercent)) / 100) * 50;
  return Math.round(dipPart + fundPart);
}

// Final rating uses the *percentage* of available fundamentals that pass, so a stock
// with PEG missing and the other 4 passing (4/4 = 100%) still earns "Instant Buy" —
// missing data must not unfairly penalize.
export function combineRatings(
  dip: DipAnalysisResult,
  fundamentals: FundamentalAnalysisResult,
): CombinedRatingResult {
  const dipStrong = dip.label === 'GOOD DIP';
  const dipWeak = dip.label === 'AVOID';
  const pct = fundamentals.fundamentalPercent;
  const noFundData = fundamentals.availableCount === 0;

  let rating: FinalRating;
  let reasoning: string;

  if (noFundData) {
    rating = 'HOLD / MIXED SIGNALS';
    reasoning = 'No fundamental data was available, so a confident verdict cannot be made. Treat the dip signal alone with caution.';
  } else if (dipStrong && pct >= 100) {
    rating = 'INSTANT BUY';
    reasoning = `The technical dip setup is strong and every available fundamental check passes (${fundamentals.score}/${fundamentals.availableCount}). Timing and quality both align.`;
  } else if (dipStrong && pct >= 80) {
    rating = 'STRONG BUY CANDIDATE';
    reasoning = `The dip setup is strong and ${pct}% of available fundamentals pass. One weak fundamental keeps it from a perfect score.`;
  } else if (dipStrong && pct >= 60) {
    rating = 'GOOD DIP, BUT NEEDS MORE RESEARCH';
    reasoning = `Timing looks good, but only ${pct}% of available fundamentals pass. Confirm the company story before acting.`;
  } else if (dipStrong && pct < 60) {
    rating = 'VALUE TRAP RISK';
    reasoning = 'The price has dipped, but weak fundamentals suggest the dip may be deserved rather than an opportunity.';
  } else if (!dipStrong && pct >= 80) {
    rating = 'GREAT COMPANY, BAD ENTRY';
    reasoning = 'The fundamentals are strong, but the technical entry is not. Consider waiting for a better dip.';
  } else if (dipWeak && pct < 60) {
    rating = 'AVOID';
    reasoning = 'Both the dip setup and the fundamentals are weak. No clear reason to buy here.';
  } else {
    rating = 'HOLD / MIXED SIGNALS';
    reasoning = 'Signals are mixed — neither timing nor quality offers a strong case in either direction.';
  }

  const warnings: string[] = [];
  if (fundamentals.missingCount > 0 && fundamentals.availableCount > 0) {
    warnings.push(
      `${fundamentals.missingCount} of ${fundamentals.maxScore} fundamental metric${fundamentals.missingCount === 1 ? ' is' : 's are'} unavailable; the quality score is computed from the ${fundamentals.availableCount} available.`,
    );
  }
  if (fundamentals.warning) warnings.push(fundamentals.warning);

  return {
    rating,
    reasoning,
    warning: warnings.length ? warnings.join(' ') : null,
  };
}
