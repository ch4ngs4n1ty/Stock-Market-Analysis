import { Router, Request, Response, NextFunction } from 'express';
import * as cache from './cache';
import { fetchPrice, fetchMetrics, PriceData, MetricData } from './finnhub';
import { computeScore } from './scorer';

const router = Router();

const PRICE_TTL  = 30 * 1_000;           // 30 seconds
const METRIC_TTL = 24 * 60 * 60 * 1_000; // 24 hours

function r2(v: number | null): number | null {
  return v != null ? Math.round(v * 100) / 100 : null;
}

// ── GET /stock/:symbol ────────────────────────────────────────────────────────

router.get('/stock/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbol = req.params.symbol.toUpperCase().trim();

    const [price, metrics] = await Promise.all([
      cache.getOrSet<PriceData>(`price:${symbol}`, PRICE_TTL, () => fetchPrice(symbol)),
      cache.getOrSet<MetricData>(`metrics:${symbol}`, METRIC_TTL, () => fetchMetrics(symbol)),
    ]);

    // Derived fields that combine price + metrics
    const relativeVolume =
      price.volume != null && metrics.avgVolume10d != null && metrics.avgVolume10d > 0
        ? price.volume / metrics.avgVolume10d
        : null;

    const distFrom52wHigh =
      price.price != null && metrics.high52w != null && metrics.high52w > 0
        ? ((price.price - metrics.high52w) / metrics.high52w) * 100
        : null;

    const score = computeScore({
      revenueGrowthYoy: metrics.revenueGrowthYoy,
      epsGrowthYoy:     metrics.epsGrowthYoy,
      grossMargin:      metrics.grossMargin,
      operatingMargin:  metrics.operatingMargin,
      netMargin:        metrics.netMargin,
      roe:              metrics.roe,
      debtToEquity:     metrics.debtToEquity,
      currentRatio:     metrics.currentRatio,
      relativeVolume,
      distFrom52wHigh,
      price:            price.price,
      ma200d:           metrics.ma200d,
    });

    res.json({
      symbol,
      // ── Price & technicals ──
      price:           price.price,
      changePct:       r2(price.changePct),
      volume:          price.volume,
      relativeVolume:  r2(relativeVolume),
      high52w:         metrics.high52w,
      low52w:          metrics.low52w,
      distFrom52wHigh: r2(distFrom52wHigh),
      ma50d:           metrics.ma50d,
      ma200d:          metrics.ma200d,
      // ── Fundamentals ────────
      fundamentals: {
        revenueGrowthYoy: metrics.revenueGrowthYoy,
        epsGrowthYoy:     metrics.epsGrowthYoy,
        grossMargin:      metrics.grossMargin,
        operatingMargin:  metrics.operatingMargin,
        netMargin:        metrics.netMargin,
        roe:              metrics.roe,
        debtToEquity:     metrics.debtToEquity,
        currentRatio:     metrics.currentRatio,
        freeCashFlow:     metrics.freeCashFlow,
      },
      // ── Research score ───────
      score,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

export default router;
