import { normalizeMarketData, normalizeFinnhubFundamentals } from '../../src/shared/normalizer/stock-normalizer';

describe('normalizeMarketData', () => {
  const rawFinnhub = {
    quote: { c: 189.42, pc: 187.15, v: 72843100 },
    metric: {
      metric: {
        '52WeekHigh': 199.62,
        '52WeekLow':  164.08,
        '50DayMovingAverage':  184.76,
        '200DayMovingAverage': 179.33,
        '10DayAverageTradingVolume': 58.2, // millions
      },
    },
  };

  it('computes changePct correctly', () => {
    const result = normalizeMarketData('AAPL', rawFinnhub);
    expect(result.changePct).toBeCloseTo(1.21, 1);
  });

  it('computes relativeVolume correctly', () => {
    const result = normalizeMarketData('AAPL', rawFinnhub);
    // 72843100 / (58.2 * 1_000_000) ≈ 1.25
    expect(result.relativeVolume).toBeCloseTo(1.25, 1);
  });

  it('computes distFrom52wHigh correctly', () => {
    const result = normalizeMarketData('AAPL', rawFinnhub);
    // (189.42 - 199.62) / 199.62 * 100 ≈ -5.11
    expect(result.distFrom52wHigh).toBeCloseTo(-5.11, 0);
  });

  it('sets aboveMA200d correctly', () => {
    const result = normalizeMarketData('AAPL', rawFinnhub);
    expect(result.aboveMA200d).toBe(true); // 189.42 > 179.33
  });

  it('handles missing data gracefully', () => {
    const result = normalizeMarketData('AAPL', { quote: {}, metric: { metric: {} } });
    expect(result.price).toBeNull();
    expect(result.relativeVolume).toBeNull();
    expect(result.changePct).toBeNull();
  });
});

describe('normalizeFinnhubFundamentals', () => {
  const rawMetrics = {
    metric: {
      revenueTTM:             385600000000,
      revenueGrowthTTMYoy:    0.078,
      epsTTM:                 6.43,
      epsGrowthTTMYoy:        0.112,
      grossMarginTTM:         0.446,
      operatingMarginTTM:     0.298,
      netProfitMarginTTM:     0.253,
      roeTTM:                 1.72,
      roaTTM:                 0.28,
      totalDebt_totalEquityAnnual: 1.51,
      currentRatioAnnual:     0.99,
      freeCashFlowTTM:        99584000000,
      peBasicExclExtraTTM:    29.46,
      psTTM:                  7.82,
      pbAnnual:               46.1,
    },
  };

  it('maps all fields correctly', () => {
    const result = normalizeFinnhubFundamentals('AAPL', rawMetrics);
    expect(result.symbol).toBe('AAPL');
    expect(result.source).toBe('finnhub');
    expect(result.revenueGrowthYoy).toBeCloseTo(0.078);
    expect(result.grossMargin).toBeCloseTo(0.446);
    expect(result.debtToEquity).toBeCloseTo(1.51);
  });

  it('returns null for missing fields', () => {
    const result = normalizeFinnhubFundamentals('AAPL', { metric: {} });
    expect(result.revenueGrowthYoy).toBeNull();
    expect(result.grossMargin).toBeNull();
  });
});
