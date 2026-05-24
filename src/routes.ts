import { Router, Request, Response, NextFunction } from 'express';
import * as cache from './cache';
import {
  CandleData,
  fetchCompanyFundamentals,
  fetchCompanyNews,
  fetchDailyCandles,
  fetchQuote,
  fetchRsi,
  IndicatorData,
  NewsHeadline,
  QuoteData,
} from './finnhub';
import { CompanyFundamentals } from './fmp';
import { discoverSp500Candidates, fetchSp500SectorMap } from './discover';
import {
  analyzeDip,
  analyzeFundamentals,
  combineRatings,
  combinedScore,
} from './scorer';
import { analyzeNlp, NlpScoreResult, DipIntegrationResult } from './nlpScorer';

const router = Router();

const QUOTE_TTL = 30 * 1_000;
const CANDLE_TTL = 15 * 60 * 1_000;
const RSI_TTL = 15 * 60 * 1_000;
const NEWS_TTL = 15 * 60 * 1_000;
const FUNDAMENTALS_TTL = 12 * 60 * 60 * 1_000;
// News sentiment doesn't shift second-to-second; 15min keeps /scan fast.
const NLP_TTL = 15 * 60 * 1_000;

type NlpAnalysis = NlpScoreResult & { dip_integration?: DipIntegrationResult };

// Non-fatal NLP: if FinBERT/HF or Finnhub news fails, return null so the rest
// of the analysis still renders. The UI hides the pillar when nlp is null.
async function safeNlp(symbol: string, dipSignal: boolean): Promise<NlpAnalysis | null> {
  try {
    return await cache.getOrSet<NlpAnalysis>(
      `nlp:${symbol}:${dipSignal ? 1 : 0}`,
      NLP_TTL,
      () => analyzeNlp(symbol, dipSignal),
    );
  } catch {
    return null;
  }
}

const COMBINED_DISCLAIMER =
  'This is not financial advice. This tool is only a stock screening system. Always review news, earnings, industry trends, and personal risk before investing.';

// Backup pool used only if discovery returns nothing (e.g. FMP outage).
const FALLBACK_WATCHLIST = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META',
  'TSLA', 'JPM', 'V', 'UNH', 'WMT', 'COST',
];

const MAX_WATCHLIST = 30;
const SCAN_CONCURRENCY = 4;
// Cold scans pay AV's 5-req/min serialization (~12s per uncached candle call).
// 15 candidates × 12s ≈ 3 min worst case; cache makes follow-up scans fast.
const DISCOVERY_POOL_SIZE = 15;
const TOP_N_RETURNED = 10;

function normalizeSymbol(raw: string): string {
  const symbol = raw.toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    const err = new Error(`Invalid stock symbol: ${raw}`);
    (err as { status?: number }).status = 400;
    throw err;
  }
  return symbol;
}

async function mapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildAnalysis(symbol: string) {
  const [quote, candles, rsi, news, fundamentalsRaw] = await Promise.all([
    cache.getOrSet<QuoteData>(`quote:${symbol}`, QUOTE_TTL, () => fetchQuote(symbol)),
    cache.getOrSet<CandleData>(`candles:${symbol}`, CANDLE_TTL, () => fetchDailyCandles(symbol)),
    cache.getOrSet<IndicatorData>(`rsi:${symbol}`, RSI_TTL, () => fetchRsi(symbol)),
    cache.getOrSet<NewsHeadline[]>(`news:${symbol}`, NEWS_TTL, () => fetchCompanyNews(symbol)),
    cache.getOrSet<CompanyFundamentals>(
      `fundamentals:${symbol}`,
      FUNDAMENTALS_TTL,
      () => fetchCompanyFundamentals(symbol),
    ),
  ]);

  const dip = analyzeDip({
    ticker: symbol,
    quote,
    candles,
    rsi: rsi.rsi,
    news,
    dataWarnings: [candles.warning].filter((warning): warning is string => Boolean(warning)),
  });

  const fundamentals = analyzeFundamentals(fundamentalsRaw);
  const combined = combineRatings(dip, fundamentals);
  const overall = combinedScore(dip, fundamentals);

  // News sentiment runs in parallel with the rest; failure is non-fatal.
  // The dip signal is the technical "GOOD DIP" verdict, fed into integrateDipSignal()
  // so the news-driven score and dip signal combine into one verdict.
  const nlp = await safeNlp(symbol, dip.label === 'GOOD DIP');

  return {
    ...dip,
    fundamentals,
    combined,
    combinedScore: overall,
    nlp,
    disclaimer: COMBINED_DISCLAIMER,
  };
}

function toScanItem(
  analysis: Awaited<ReturnType<typeof buildAnalysis>>,
  sector: string | null,
) {
  return {
    ticker: analysis.ticker,
    sector,
    currentPrice: analysis.currentPrice,
    dailyPercentChange: analysis.dailyPercentChange,
    dipScore: analysis.score,
    dipLabel: analysis.label,
    dipPercentage: analysis.dipPercentage,
    recentHighWindow: analysis.recentHighWindow,
    trendDirection: analysis.trendDirection,
    sma20: analysis.sma20,
    sma50: analysis.sma50,
    rsi: analysis.rsi,
    badNewsFlag: analysis.badNewsFlag,
    fundamentals: analysis.fundamentals,
    fundamentalPercent: analysis.fundamentals.fundamentalPercent,
    combined: analysis.combined,
    combinedScore: analysis.combinedScore,
    nlp: analysis.nlp ? {
      score: analysis.nlp.score,
      label: analysis.nlp.label,
      topHeadline: analysis.nlp.top_headline,
      reasoning: analysis.nlp.reasoning,
      sentimentSummary: analysis.nlp.sentiment_summary,
      sentimentSource: analysis.nlp.sentiment_source,
      dipIntegration: analysis.nlp.dip_integration ?? null,
    } : null,
    dataWarnings: analysis.dataWarnings,
  };
}

// Parse an explicit ?symbols=AAPL,MSFT,... override. Returns null when no override
// was provided so the caller knows to fall through to dynamic discovery.
function parseSymbolsParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const split = raw.split(/[\s,]+/).filter(Boolean);
  if (!split.length) return null;
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const item of split) {
    const sym = normalizeSymbol(item);
    if (!seen.has(sym)) {
      seen.add(sym);
      symbols.push(sym);
    }
    if (symbols.length >= MAX_WATCHLIST) break;
  }
  return symbols;
}

interface ScanSource {
  mode: 'explicit' | 'discovered' | 'fallback';
  symbols: string[];
  universe: 'sp500' | 'custom' | 'fallback';
  discoveryRawCount?: number;
  discoveryFilteredCount?: number;
  sp500Matched?: number;
  paddedFromRotation?: number;
  discoverySource?: 'sp500-losers' | 'sp500-rotation' | 'mixed';
  warning?: string;
}

// Decide what to scan. Phase 1 production behavior:
//   - Explicit ?symbols=... wins (user override; bypasses S&P 500 filter)
//   - Otherwise discover today's biggest losers ∩ S&P 500 (institutional-quality
//     opportunities only — no penny stocks, OTC, leveraged ETPs)
//   - On a calm day with too few S&P 500 names in the losers feed, the discoverer
//     pads with a deterministic daily-rotation slice of the S&P 500
//   - If FMP is fully unreachable, fall back to a small curated mega-cap list so
//     the board is never empty
async function resolveScanSymbols(rawParam: string | undefined): Promise<ScanSource> {
  const explicit = parseSymbolsParam(rawParam);
  if (explicit) {
    return { mode: 'explicit', universe: 'custom', symbols: explicit };
  }

  // Always populate enough to fill the top-10 board even on calm market days.
  const discovery = await discoverSp500Candidates(DISCOVERY_POOL_SIZE, TOP_N_RETURNED);
  if (discovery.candidates.length > 0) {
    return {
      mode: 'discovered',
      universe: 'sp500',
      symbols: discovery.candidates,
      discoveryRawCount: discovery.rawCount,
      discoveryFilteredCount: discovery.filteredCount,
      sp500Matched: discovery.sp500Matched,
      paddedFromRotation: discovery.paddedFromRotation,
      discoverySource: discovery.source,
    };
  }

  return {
    mode: 'fallback',
    universe: 'fallback',
    symbols: FALLBACK_WATCHLIST,
    warning: 'S&P 500 discovery unavailable; using curated mega-cap fallback.',
  };
}

router.get('/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await resolveScanSymbols(req.query.symbols as string | undefined);

    // Sector tag per ticker — fetched once per scan (24h cache), reused across cards.
    // Non-S&P 500 symbols (custom override) get null and the UI just hides the tag.
    const sectorMap = await cache.getOrSet<Map<string, string>>(
      'sp500:sectors',
      24 * 60 * 60 * 1_000,
      () => fetchSp500SectorMap(),
    );

    const settled = await mapLimit(source.symbols, SCAN_CONCURRENCY, async (sym) => {
      try {
        const analysis = await buildAnalysis(sym);
        const sector = sectorMap.get(sym) ?? null;
        return { symbol: sym, item: toScanItem(analysis, sector), error: null as string | null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return { symbol: sym, item: null, error: message };
      }
    });

    // Rank by combined score, then take top N. For the discovery path this surfaces
    // "best of today's pool"; for explicit lists it's the user's own ranked watchlist.
    const ranked = settled
      .map((r) => r.item)
      .filter((it): it is NonNullable<typeof it> => it !== null)
      .sort((a, b) => b.combinedScore - a.combinedScore);

    const items = source.mode === 'explicit' ? ranked : ranked.slice(0, TOP_N_RETURNED);

    const errors = settled
      .filter((r) => r.error)
      .map((r) => ({ symbol: r.symbol, error: r.error as string }));

    res.json({
      generatedAt: new Date().toISOString(),
      mode: source.mode,
      universe: source.universe,
      symbolsScanned: source.symbols,
      poolSize: source.symbols.length,
      returnedCount: items.length,
      discovery: source.mode === 'discovered'
        ? {
            rawCount: source.discoveryRawCount,
            filteredCount: source.discoveryFilteredCount,
            sp500Matched: source.sp500Matched,
            paddedFromRotation: source.paddedFromRotation,
            source: source.discoverySource,
          }
        : undefined,
      sourceWarning: source.warning,
      items,
      errors,
      disclaimer: COMBINED_DISCLAIMER,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/stock/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    res.json(await buildAnalysis(symbol));
  } catch (err) {
    next(err);
  }
});

router.get('/dip/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    res.json(await buildAnalysis(symbol));
  } catch (err) {
    next(err);
  }
});

// NLP-powered buy/risk score using FinBERT-style sentiment on the last 24h of news.
// The dip signal from the existing technical analyzer is fed into integrateDipSignal()
// so the news-driven score and the dip signal combine into a single verdict.
// Pass ?dip=true|false to override the auto-derived dip signal.
router.get('/nlp/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const dipParam = req.query.dip;

    // No override → reuse the cached NLP slice that buildAnalysis already computed.
    if (dipParam !== 'true' && dipParam !== 'false') {
      const analysis = await buildAnalysis(symbol);
      if (!analysis.nlp) {
        res.status(503).json({ error: 'NLP scoring unavailable' });
        return;
      }
      res.json({ ...analysis.nlp, disclaimer: COMBINED_DISCLAIMER });
      return;
    }

    // Explicit override → bypass cache and recompute with the requested dip signal.
    const result = await analyzeNlp(symbol, dipParam === 'true');
    res.json({ ...result, disclaimer: COMBINED_DISCLAIMER });
  } catch (err) {
    next(err);
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

export default router;
