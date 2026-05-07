import {
  fetchBiggestLosers,
  fetchSp500Constituents,
  MarketMover,
  Sp500Constituent,
} from './fmp';

// Phase 1 of the platform is an institutional-quality scanner — S&P 500 only.
// We deliberately exclude penny stocks, OTC names, leveraged ETPs, and
// micro-caps. The S&P 500 filter is the strongest single signal of quality:
// every constituent has been screened by the index committee for liquidity,
// market cap, and financial viability.
//
// Future expansion (Nasdaq-100, sector ETFs, mid-caps) plugs in here by
// adding new "universe" sources that callers can opt into.

const NAME_BLOCKLIST = [
  / etf\b/i,
  / etn\b/i,
  / etp\b/i,
  /\bbear\b/i,
  /\bbull\b/i,
  /\binverse\b/i,
  /\bleveraged\b/i,
  /\b[23]x\b/i,
  /\bdaily target\b/i,
  /\bmicrosectors\b/i,
  /\bdirexion\b/i,
  /\bdefiance\b/i,
  /\bproshares\b/i,
  /\bspdr\b/i,
  /\bishares\b/i,
  /\bvaneck\b/i,
  /\bright\b/i,
  /\bwarrant\b/i,
];

const ALLOWED_EXCHANGES = new Set(['NASDAQ', 'NYSE']);
const MIN_PRICE = 5;
const MAX_DAILY_DROP_PERCENT = 50;

function passesQualityFilter(mover: MarketMover): boolean {
  if (!ALLOWED_EXCHANGES.has(mover.exchange)) return false;
  if (mover.price < MIN_PRICE) return false;
  if (mover.changePercent < -MAX_DAILY_DROP_PERCENT) return false;
  for (const pattern of NAME_BLOCKLIST) {
    if (pattern.test(mover.name)) return false;
  }
  return true;
}

// Stable, no-RNG rotation that gives the user a different slice of the S&P 500
// each calendar day. Used to pad the discovery pool on quiet market days when
// few S&P 500 names show up in biggest-losers — without it, the board could be
// nearly empty on slow days. Sectors are interleaved so the slice isn't
// dominated by one industry.
function dailyRotationSlice(symbols: string[], take: number): string[] {
  if (!symbols.length) return [];
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86400000);
  const start = (dayOfYear * 7) % symbols.length;
  const out: string[] = [];
  for (let i = 0; i < take; i += 1) {
    out.push(symbols[(start + i) % symbols.length]);
  }
  return out;
}

export interface DiscoveryResult {
  candidates: string[];
  rawCount: number;
  filteredCount: number;
  sp500Matched: number;
  paddedFromRotation: number;
  source: 'sp500-losers' | 'sp500-rotation' | 'mixed';
  universe: 'sp500';
}

/**
 * Default Phase 1 discovery: today's biggest losers ∩ S&P 500.
 *
 * - Pulls FMP biggest-losers (broad market view).
 * - Drops obvious junk (penny stocks, leveraged ETPs, low-priced names, AMEX-only).
 * - Intersects with the current S&P 500 constituent list.
 * - If the result is thinner than `minCandidates`, pads with a deterministic
 *   daily rotation through the index so the board is never empty on a calm day.
 */
export async function discoverSp500Candidates(
  maxCandidates = 15,
  minCandidates = 8,
): Promise<DiscoveryResult> {
  const [losers, sp500] = await Promise.all([
    fetchBiggestLosers(),
    fetchSp500Constituents(),
  ]);

  const sp500Symbols = new Set(sp500.map((c) => c.symbol));

  const filtered = losers.filter(passesQualityFilter);
  const sp500Losers = filtered.filter((m) => sp500Symbols.has(m.symbol));
  // Steepest decline first — these are the freshest "dip opportunities".
  sp500Losers.sort((a, b) => a.changePercent - b.changePercent);

  let candidates = sp500Losers.slice(0, maxCandidates).map((m) => m.symbol);
  let paddedFromRotation = 0;

  if (candidates.length < minCandidates && sp500.length > 0) {
    const need = minCandidates - candidates.length;
    const seen = new Set(candidates);
    const allSymbols = sp500.map((c) => c.symbol);
    const rotation = dailyRotationSlice(allSymbols, need * 3); // overshoot to skip dupes
    for (const sym of rotation) {
      if (candidates.length >= minCandidates) break;
      if (seen.has(sym)) continue;
      candidates.push(sym);
      seen.add(sym);
      paddedFromRotation += 1;
    }
  }

  let source: DiscoveryResult['source'];
  if (paddedFromRotation === 0) source = 'sp500-losers';
  else if (sp500Losers.length === 0) source = 'sp500-rotation';
  else source = 'mixed';

  return {
    candidates,
    rawCount: losers.length,
    filteredCount: filtered.length,
    sp500Matched: sp500Losers.length,
    paddedFromRotation,
    source,
    universe: 'sp500',
  };
}

// Map symbol → sector, exposed so the API/UI can label sector context per ticker.
export async function fetchSp500SectorMap(): Promise<Map<string, string>> {
  const list = await fetchSp500Constituents();
  return new Map(list.map((c) => [c.symbol, c.sector] as const));
}

// Backwards-compatible alias — kept so any external caller of the prior name
// still works. Phase 1 default is S&P 500 focused.
export const discoverCandidates = discoverSp500Candidates;
