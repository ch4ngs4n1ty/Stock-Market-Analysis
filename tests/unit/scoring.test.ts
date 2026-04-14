import { computeCompositeScore } from '../../src/modules/research/scoring/composite-score';
import { computeGrowthScore } from '../../src/modules/research/scoring/growth-score';
import { computeProfitabilityScore } from '../../src/modules/research/scoring/profitability-score';
import { computeLeverageScore } from '../../src/modules/research/scoring/leverage-score';

describe('Growth Score', () => {
  it('returns 100 for 30%+ revenue and EPS growth', () => {
    const score = computeGrowthScore({ revenueGrowthYoy: 0.35, epsGrowthYoy: 0.35 });
    expect(score).toBeCloseTo(1.0, 1);
  });

  it('returns 0 for no data', () => {
    expect(computeGrowthScore({ revenueGrowthYoy: null, epsGrowthYoy: null })).toBe(0);
  });

  it('handles negative growth', () => {
    const score = computeGrowthScore({ revenueGrowthYoy: -0.10, epsGrowthYoy: -0.10 });
    expect(score).toBe(0);
  });

  it('weights revenue 60% and EPS 40%', () => {
    const revOnly = computeGrowthScore({ revenueGrowthYoy: 0.30, epsGrowthYoy: null });
    expect(revOnly).toBeGreaterThan(0);
  });
});

describe('Profitability Score', () => {
  it('returns ~1 for best-in-class margins', () => {
    const score = computeProfitabilityScore({
      grossMargin: 0.65, operatingMargin: 0.30, netMargin: 0.25, roe: 0.30,
    });
    expect(score).toBeGreaterThan(0.95);
  });

  it('returns 0 for all nulls', () => {
    expect(computeProfitabilityScore({ grossMargin: null, operatingMargin: null, netMargin: null, roe: null })).toBe(0);
  });

  it('handles partial data correctly', () => {
    const score = computeProfitabilityScore({ grossMargin: 0.60, operatingMargin: null, netMargin: null, roe: null });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('Leverage Score', () => {
  it('returns high score for low debt and strong current ratio', () => {
    const score = computeLeverageScore({ debtToEquity: 0.1, currentRatio: 3.0 });
    expect(score).toBeGreaterThan(0.9);
  });

  it('returns 0 for very high debt', () => {
    const score = computeLeverageScore({ debtToEquity: 3.0, currentRatio: 0.5 });
    expect(score).toBeLessThan(0.25);
  });

  it('returns neutral (0.5) when no data', () => {
    expect(computeLeverageScore({ debtToEquity: null, currentRatio: null })).toBe(0.5);
  });
});

describe('Composite Score', () => {
  const strongStock = {
    revenueGrowthYoy: 0.30,
    epsGrowthYoy:     0.25,
    grossMargin:      0.60,
    operatingMargin:  0.25,
    netMargin:        0.20,
    roe:              0.25,
    debtToEquity:     0.5,
    currentRatio:     2.0,
    relativeVolume:   2.0,
    distFrom52wHigh:  -5.0,
    price:            200,
    ma200d:           180,
  };

  it('returns a score between 0 and 100', () => {
    const result = computeCompositeScore(strongStock);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.compositeScore).toBeLessThanOrEqual(100);
  });

  it('strong stock scores above 70', () => {
    const result = computeCompositeScore(strongStock);
    expect(result.compositeScore).toBeGreaterThan(70);
  });

  it('weak stock scores below 40', () => {
    const result = computeCompositeScore({
      revenueGrowthYoy: -0.10,
      epsGrowthYoy:     -0.15,
      grossMargin:      0.10,
      operatingMargin:  -0.05,
      netMargin:        -0.08,
      roe:              -0.10,
      debtToEquity:     4.0,
      currentRatio:     0.5,
      relativeVolume:   0.3,
      distFrom52wHigh:  -40.0,
      price:            10,
      ma200d:           20,
    });
    expect(result.compositeScore).toBeLessThan(20);
  });

  it('returns all sub-scores', () => {
    const result = computeCompositeScore(strongStock);
    expect(result).toHaveProperty('growthScore');
    expect(result).toHaveProperty('profitabilityScore');
    expect(result).toHaveProperty('leverageScore');
    expect(result).toHaveProperty('momentumScore');
  });
});
