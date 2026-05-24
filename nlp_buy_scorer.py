"""
NLP-powered buy/risk scoring engine.

Pipeline:
    1. Fetch last-24h company news from Finnhub.
    2. Run FinBERT (ProsusAI/finbert) sentiment on headline + summary.
    3. Aggregate into a 0-100 buy score with a BUY / HOLD / AVOID label.
    4. Expose integrate_dip_signal() so an external dip-detector can adjust the score.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch


FINNHUB_URL = "https://finnhub.io/api/v1/company-news"
FINBERT_MODEL = "ProsusAI/finbert"
TICKERS = ["AAPL"]

_tokenizer = None
_model = None
_label_map: dict[int, str] = {}


def _load_finbert() -> None:
    global _tokenizer, _model, _label_map
    if _model is not None:
        return
    _tokenizer = AutoTokenizer.from_pretrained(FINBERT_MODEL)
    _model = AutoModelForSequenceClassification.from_pretrained(FINBERT_MODEL)
    _model.eval()
    # FinBERT's id2label: {0: 'positive', 1: 'negative', 2: 'neutral'}
    _label_map = {int(k): v.lower() for k, v in _model.config.id2label.items()}


# ---------- 1. FETCH NEWS -------------------------------------------------


def fetch_news(ticker: str, api_key: str, hours: int = 24) -> list[dict[str, Any]]:
    """Fetch company-news for `ticker` within the last `hours` hours."""
    now = datetime.now(timezone.utc)
    frm = (now - timedelta(hours=hours)).date().isoformat()
    to = now.date().isoformat()

    resp = requests.get(
        FINNHUB_URL,
        params={"symbol": ticker, "from": frm, "to": to, "token": api_key},
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()

    cutoff_ts = (now - timedelta(hours=hours)).timestamp()
    articles = []
    for a in raw:
        ts = a.get("datetime", 0)
        if ts < cutoff_ts:
            continue
        # Filter: the requested ticker must be the primary subject.
        # Finnhub's `related` field is a comma-separated string of tickers;
        # the first one is treated as the primary subject.
        related = (a.get("related") or "").upper().split(",")
        if not related or related[0].strip() != ticker.upper():
            continue
        articles.append(a)

    return articles


# ---------- 2. NLP SENTIMENT ----------------------------------------------


@dataclass
class ScoredArticle:
    headline: str
    source: str
    datetime: str  # ISO-8601
    timestamp: int  # unix seconds
    sentiment: str  # positive | negative | neutral
    confidence: float


def _score_text(text: str) -> tuple[str, float]:
    _load_finbert()
    assert _tokenizer is not None and _model is not None
    inputs = _tokenizer(
        text, return_tensors="pt", truncation=True, max_length=512, padding=True
    )
    with torch.no_grad():
        logits = _model(**inputs).logits
    probs = torch.softmax(logits, dim=-1).squeeze(0).tolist()
    idx = int(max(range(len(probs)), key=lambda i: probs[i]))
    return _label_map[idx], float(probs[idx])


def score_articles(articles: list[dict[str, Any]]) -> list[ScoredArticle]:
    scored: list[ScoredArticle] = []
    for a in articles:
        headline = (a.get("headline") or "").strip()
        summary = (a.get("summary") or "").strip()
        text = f"{headline}. {summary}".strip(". ").strip()
        if not text:
            continue
        label, conf = _score_text(text)
        ts = int(a.get("datetime", 0))
        scored.append(
            ScoredArticle(
                headline=headline,
                source=a.get("source", "unknown"),
                datetime=datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                timestamp=ts,
                sentiment=label,
                confidence=conf,
            )
        )
    return scored


# ---------- 3. SCORING ENGINE ---------------------------------------------


@dataclass
class TickerResult:
    ticker: str
    score: int
    label: str
    sentiment_summary: dict[str, Any]
    top_headline: str | None
    reasoning: str
    articles: list[ScoredArticle] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ticker": self.ticker,
            "score": self.score,
            "label": self.label,
            "sentiment_summary": self.sentiment_summary,
            "top_headline": self.top_headline,
            "reasoning": self.reasoning,
            "articles": [a.__dict__ for a in self.articles],
        }


def _label_for(score: int) -> str:
    if score >= 65:
        return "BUY"
    if score >= 40:
        return "HOLD"
    return "AVOID"


def compute_buy_score(ticker: str, scored: list[ScoredArticle]) -> TickerResult:
    if not scored:
        return TickerResult(
            ticker=ticker,
            score=50,
            label="HOLD",
            sentiment_summary={"positive": 0, "negative": 0, "neutral": 0, "n": 0},
            top_headline=None,
            reasoning="No qualifying news in the last 24h; defaulting to neutral.",
        )

    # Recency-weighted aggregation: half-life of 6 hours.
    now_ts = datetime.now(timezone.utc).timestamp()
    half_life_s = 6 * 3600

    polarity_sum = 0.0
    weight_sum = 0.0
    counts = {"positive": 0, "negative": 0, "neutral": 0}

    for art in scored:
        counts[art.sentiment] = counts.get(art.sentiment, 0) + 1
        age = max(0.0, now_ts - art.timestamp)
        recency_w = math.pow(0.5, age / half_life_s)
        # Polarity in [-1, +1] scaled by FinBERT confidence.
        polarity = (
            art.confidence
            if art.sentiment == "positive"
            else -art.confidence
            if art.sentiment == "negative"
            else 0.0
        )
        polarity_sum += polarity * recency_w
        weight_sum += recency_w

    avg_polarity = polarity_sum / weight_sum if weight_sum else 0.0  # [-1, +1]
    # Map [-1, +1] linearly to [0, 100].
    score = int(round((avg_polarity + 1.0) * 50.0))
    score = max(0, min(100, score))
    label = _label_for(score)

    # "Top headline" = highest-confidence non-neutral, recent article.
    def _rank(a: ScoredArticle) -> float:
        recency_w = math.pow(0.5, max(0.0, now_ts - a.timestamp) / half_life_s)
        weight = a.confidence * recency_w
        if a.sentiment == "neutral":
            weight *= 0.25
        return weight

    top = max(scored, key=_rank)

    reasoning = (
        f"Analyzed {len(scored)} article(s) in the last 24h "
        f"({counts['positive']} positive, {counts['negative']} negative, "
        f"{counts['neutral']} neutral). Recency-weighted polarity "
        f"{avg_polarity:+.2f} → score {score}/100 → {label}."
    )

    return TickerResult(
        ticker=ticker,
        score=score,
        label=label,
        sentiment_summary={**counts, "n": len(scored), "avg_polarity": round(avg_polarity, 3)},
        top_headline=top.headline,
        reasoning=reasoning,
        articles=scored,
    )


# ---------- 4. DIP MODEL INTEGRATION HOOK ---------------------------------


def integrate_dip_signal(
    ticker: str, buy_score: int, dip_signal: bool
) -> dict[str, Any]:
    """Combine an external dip-detector signal with the news-driven buy score.

    Rules:
        - dip_signal True and buy_score >= 50  → +15 (capped at 100), relabel.
        - dip_signal True and buy_score <  40  → news risk overrides dip; label stays AVOID.
        - Otherwise the score is unchanged.
    """
    original = buy_score
    adjusted = buy_score
    note = "no dip signal"

    if dip_signal:
        if buy_score >= 50:
            adjusted = min(100, buy_score + 15)
            note = f"dip + bullish news → boosted {original}→{adjusted}"
            label = _label_for(adjusted)
        elif buy_score < 40:
            label = "AVOID"
            note = "dip detected but news is bearish; AVOID overrides"
        else:  # 40 <= buy_score < 50
            label = _label_for(adjusted)
            note = "dip detected but news only mildly positive; no boost"
    else:
        label = _label_for(adjusted)

    return {
        "ticker": ticker,
        "original_score": original,
        "final_score": adjusted,
        "label": label,
        "dip_signal": dip_signal,
        "note": note,
    }


# ---------- 5. ORCHESTRATION + CLI ----------------------------------------


def analyze_ticker(
    ticker: str, api_key: str, dip_signal: bool | None = None
) -> dict[str, Any]:
    articles = fetch_news(ticker, api_key)
    scored = score_articles(articles)
    result = compute_buy_score(ticker, scored)

    out = result.to_dict()
    if dip_signal is not None:
        out["dip_integration"] = integrate_dip_signal(ticker, result.score, dip_signal)
    return out


def print_summary(result: dict[str, Any]) -> None:
    print(f"\n=== {result['ticker']} ===")
    print(f"Score : {result['score']}/100   Label: {result['label']}")
    print(f"Top   : {result['top_headline'] or '(no headline)'}")
    print(f"Why   : {result['reasoning']}")
    s = result["sentiment_summary"]
    print(
        f"Mix   : {s.get('positive', 0)} pos / "
        f"{s.get('negative', 0)} neg / "
        f"{s.get('neutral', 0)} neu  (n={s.get('n', 0)})"
    )
    if "dip_integration" in result:
        d = result["dip_integration"]
        print(
            f"Dip   : signal={d['dip_signal']}  "
            f"{d['original_score']}→{d['final_score']} ({d['label']}) — {d['note']}"
        )


def main() -> int:
    api_key = os.environ.get("FINNHUB_KEY")
    if not api_key:
        print("ERROR: FINNHUB_KEY environment variable is not set.", file=sys.stderr)
        return 1

    # Optional: simulate a dip-model signal via CLI: `python nlp_buy_scorer.py --dip AAPL`
    dip_tickers = set()
    args = sys.argv[1:]
    if "--dip" in args:
        i = args.index("--dip")
        for t in args[i + 1 :]:
            if t.startswith("-"):
                break
            dip_tickers.add(t.upper())

    results: dict[str, Any] = {}
    for ticker in TICKERS:
        dip = ticker.upper() in dip_tickers if dip_tickers else None
        res = analyze_ticker(ticker, api_key, dip_signal=dip)
        print_summary(res)
        results[ticker] = res

    print("\n--- JSON ---")
    print(json.dumps(results, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
