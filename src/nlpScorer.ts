import axios from 'axios';
import { fetchCompanyNews, NewsHeadline } from './finnhub';

const HF_FINBERT_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';

export type Sentiment = 'positive' | 'negative' | 'neutral';
export type NlpLabel = 'BUY' | 'HOLD' | 'AVOID';
export type SentimentSource = 'finbert' | 'lexicon';

export interface ScoredArticle {
  headline: string;
  source: string | null;
  datetime: string | null;
  timestamp: number | null;
  sentiment: Sentiment;
  confidence: number;
}

export interface NlpScoreResult {
  ticker: string;
  score: number;
  label: NlpLabel;
  sentiment_summary: {
    positive: number;
    negative: number;
    neutral: number;
    n: number;
    avg_polarity: number;
  };
  top_headline: string | null;
  reasoning: string;
  articles: ScoredArticle[];
  sentiment_source: SentimentSource;
}

export interface DipIntegrationResult {
  ticker: string;
  original_score: number;
  final_score: number;
  label: NlpLabel;
  dip_signal: boolean;
  note: string;
}

// Lightweight financial-news lexicon. Keeps the scorer functional with zero
// extra config; upgrade to FinBERT by setting HUGGINGFACE_API_KEY.
const POSITIVE_TERMS = [
  'beat', 'beats', 'beat estimates', 'tops estimates', 'record', 'surge',
  'surges', 'soar', 'soars', 'rally', 'rallies', 'gains', 'gain',
  'upgrade', 'upgraded', 'raises guidance', 'raised guidance', 'strong',
  'outperform', 'buy rating', 'price target raised', 'profit', 'growth',
  'all-time high', 'breakthrough', 'partnership', 'expands', 'expanding',
  'launches', 'wins', 'approval', 'approved', 'dividend increase',
];

const NEGATIVE_TERMS = [
  'miss', 'misses', 'misses estimates', 'cuts', 'cut', 'plunge', 'plunges',
  'falls', 'fall', 'drops', 'drop', 'downgrade', 'downgraded',
  'cuts guidance', 'weak guidance', 'lawsuit', 'investigation', 'sec probe',
  'fraud', 'bankruptcy', 'chapter 11', 'recall', 'layoffs', 'data breach',
  'halts production', 'delisting', 'underperform', 'sell rating',
  'price target lowered', 'loss', 'losses', 'warning', 'concerns', 'concern',
  'risk', 'risks', 'decline', 'declines', 'slump', 'slumps',
];

function lexiconSentiment(text: string): { label: Sentiment; confidence: number } {
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const term of POSITIVE_TERMS) if (lower.includes(term)) pos += 1;
  for (const term of NEGATIVE_TERMS) if (lower.includes(term)) neg += 1;

  if (pos === 0 && neg === 0) return { label: 'neutral', confidence: 0.6 };
  if (pos === neg) return { label: 'neutral', confidence: 0.5 };

  const total = pos + neg;
  if (pos > neg) {
    return { label: 'positive', confidence: Math.min(0.95, 0.55 + 0.1 * (pos - neg) + 0.05 * total) };
  }
  return { label: 'negative', confidence: Math.min(0.95, 0.55 + 0.1 * (neg - pos) + 0.05 * total) };
}

// True only when a real-looking HF token is present. Filters out the
// `.env.example` placeholder and empty/whitespace values so we don't fire
// guaranteed-401 calls when the user hasn't actually configured a key.
function hasHuggingFaceToken(): boolean {
  const token = (process.env.HUGGINGFACE_API_KEY ?? '').trim();
  if (!token) return false;
  if (token === 'YOUR_HUGGINGFACE_TOKEN_HERE') return false;
  if (/^your[_-]/i.test(token)) return false;
  return true;
}

// FinBERT via HuggingFace Inference API. Returns null on any failure so the
// caller can fall back to the lexicon without bringing down the whole request.
async function finbertSentiment(text: string): Promise<{ label: Sentiment; confidence: number } | null> {
  if (!hasHuggingFaceToken()) return null;
  const token = (process.env.HUGGINGFACE_API_KEY ?? '').trim();

  try {
    const { data } = await axios.post(
      HF_FINBERT_URL,
      { inputs: text.slice(0, 512), options: { wait_for_model: true } },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 },
    );

    // HF returns either [[{label,score}, ...]] or [{label,score}, ...] depending
    // on the model. Normalize both shapes.
    const flat: Array<{ label: string; score: number }> = Array.isArray(data?.[0])
      ? data[0]
      : Array.isArray(data) ? data : [];
    if (!flat.length) return null;

    let best = flat[0];
    for (const entry of flat) if (entry.score > best.score) best = entry;
    const label = best.label.toLowerCase() as Sentiment;
    if (label !== 'positive' && label !== 'negative' && label !== 'neutral') return null;
    return { label, confidence: best.score };
  } catch {
    return null;
  }
}

// Last-N-hours slice of company news. Finnhub's /company-news endpoint is
// already keyed by symbol, so every article is about `ticker`; we just trim
// the existing helper's results to the time window.
async function fetchRecentPrimaryNews(ticker: string, hours = 24): Promise<NewsHeadline[]> {
  const news = await fetchCompanyNews(ticker, 2);
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  return news.filter((item) => (item.datetime ?? 0) >= cutoff);
}

async function scoreArticle(
  article: NewsHeadline,
): Promise<{ scored: ScoredArticle; source: SentimentSource } | null> {
  const headline = (article.headline ?? '').trim();
  const summary = (article.summary ?? '').trim();
  const text = `${headline}. ${summary}`.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!text) return null;

  const finbert = await finbertSentiment(text);
  const result = finbert ?? lexiconSentiment(text);
  const source: SentimentSource = finbert ? 'finbert' : 'lexicon';

  const ts = article.datetime ?? null;
  return {
    scored: {
      headline,
      source: article.source,
      datetime: ts !== null ? new Date(ts * 1000).toISOString() : null,
      timestamp: ts,
      sentiment: result.label,
      confidence: result.confidence,
    },
    source,
  };
}

function labelForScore(score: number): NlpLabel {
  if (score >= 65) return 'BUY';
  if (score >= 40) return 'HOLD';
  return 'AVOID';
}

export function computeBuyScore(ticker: string, scored: ScoredArticle[]): Omit<NlpScoreResult, 'sentiment_source'> {
  if (!scored.length) {
    return {
      ticker,
      score: 50,
      label: 'HOLD',
      sentiment_summary: { positive: 0, negative: 0, neutral: 0, n: 0, avg_polarity: 0 },
      top_headline: null,
      reasoning: 'No qualifying news in the last 24h; defaulting to neutral.',
      articles: [],
    };
  }

  // Recency weighting: half-life of 6 hours, matching the Python scorer.
  const nowTs = Math.floor(Date.now() / 1000);
  const halfLifeS = 6 * 3600;

  let polaritySum = 0;
  let weightSum = 0;
  const counts = { positive: 0, negative: 0, neutral: 0 };

  for (const art of scored) {
    counts[art.sentiment] += 1;
    const age = Math.max(0, nowTs - (art.timestamp ?? nowTs));
    const recencyW = Math.pow(0.5, age / halfLifeS);
    const polarity =
      art.sentiment === 'positive' ? art.confidence
        : art.sentiment === 'negative' ? -art.confidence
        : 0;
    polaritySum += polarity * recencyW;
    weightSum += recencyW;
  }

  const avgPolarity = weightSum ? polaritySum / weightSum : 0;
  const score = Math.max(0, Math.min(100, Math.round((avgPolarity + 1) * 50)));
  const label = labelForScore(score);

  // Top headline: highest-confidence non-neutral recent article.
  const ranked = [...scored].sort((a, b) => {
    const rank = (x: ScoredArticle) => {
      const age = Math.max(0, nowTs - (x.timestamp ?? nowTs));
      const recencyW = Math.pow(0.5, age / halfLifeS);
      const penalty = x.sentiment === 'neutral' ? 0.25 : 1;
      return x.confidence * recencyW * penalty;
    };
    return rank(b) - rank(a);
  });
  const top = ranked[0];

  const reasoning =
    `Analyzed ${scored.length} article(s) in the last 24h ` +
    `(${counts.positive} positive, ${counts.negative} negative, ${counts.neutral} neutral). ` +
    `Recency-weighted polarity ${avgPolarity >= 0 ? '+' : ''}${avgPolarity.toFixed(2)} ` +
    `→ score ${score}/100 → ${label}.`;

  return {
    ticker,
    score,
    label,
    sentiment_summary: {
      ...counts,
      n: scored.length,
      avg_polarity: Math.round(avgPolarity * 1000) / 1000,
    },
    top_headline: top.headline,
    reasoning,
    articles: scored,
  };
}

// Dip-model integration hook (mirrors the Python integrate_dip_signal()):
//   - dip + score >= 50 → +15 (capped 100), relabel
//   - dip + score <  40 → news risk overrides; AVOID
//   - otherwise          → unchanged
export function integrateDipSignal(
  ticker: string,
  buyScore: number,
  dipSignal: boolean,
): DipIntegrationResult {
  let finalScore = buyScore;
  let label = labelForScore(buyScore);
  let note = 'no dip signal';

  if (dipSignal) {
    if (buyScore >= 50) {
      finalScore = Math.min(100, buyScore + 15);
      label = labelForScore(finalScore);
      note = `dip + bullish news → boosted ${buyScore}→${finalScore}`;
    } else if (buyScore < 40) {
      label = 'AVOID';
      note = 'dip detected but news is bearish; AVOID overrides';
    } else {
      label = labelForScore(finalScore);
      note = 'dip detected but news only mildly positive; no boost';
    }
  }

  return { ticker, original_score: buyScore, final_score: finalScore, label, dip_signal: dipSignal, note };
}

export async function analyzeNlp(ticker: string, dipSignal?: boolean): Promise<NlpScoreResult & { dip_integration?: DipIntegrationResult }> {
  const articles = await fetchRecentPrimaryNews(ticker, 24);
  // Parallel scoring — sequential adds ~N×latency for FinBERT (HF API trip per article).
  const settled = await Promise.all(articles.map((a) => scoreArticle(a)));
  const scoredArticles: ScoredArticle[] = [];
  let finbertCount = 0;
  let lexiconCount = 0;
  for (const result of settled) {
    if (!result) continue;
    scoredArticles.push(result.scored);
    if (result.source === 'finbert') finbertCount += 1;
    else lexiconCount += 1;
  }

  const base = computeBuyScore(ticker, scoredArticles);
  // Report the path that actually ran the majority of articles, not just what
  // the env suggested. If nothing scored, fall back to env presence so the UI
  // still tells the user which mode is configured.
  const sentimentSource: SentimentSource =
    finbertCount + lexiconCount === 0
      ? (hasHuggingFaceToken() ? 'finbert' : 'lexicon')
      : (finbertCount >= lexiconCount ? 'finbert' : 'lexicon');

  const result: NlpScoreResult & { dip_integration?: DipIntegrationResult } = {
    ...base,
    sentiment_source: sentimentSource,
  };

  if (typeof dipSignal === 'boolean') {
    result.dip_integration = integrateDipSignal(ticker, base.score, dipSignal);
  }

  return result;
}
