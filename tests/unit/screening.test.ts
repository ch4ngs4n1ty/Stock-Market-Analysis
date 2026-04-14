import { evaluateStock, FilterRule } from '../../src/modules/screening/screening.service';

describe('evaluateStock', () => {
  const stockData = {
    revenueGrowthYoy: 0.15,
    grossMargin:      0.45,
    debtToEquity:     0.8,
    price:            210,
    ma200d:           185,
    relativeVolume:   2.1,
    compositeScore:   72,
  };

  it('passes when all rules match', () => {
    const rules: FilterRule[] = [
      { field: 'revenueGrowthYoy', operator: '>', value: 0.10 },
      { field: 'grossMargin',      operator: '>', value: 0.40 },
      { field: 'debtToEquity',     operator: '<', value: 1.0  },
    ];
    const result = evaluateStock(rules, stockData);
    expect(result.passed).toBe(true);
    expect(result.failedRules).toHaveLength(0);
    expect(result.passedRules).toHaveLength(3);
  });

  it('fails when any rule does not match', () => {
    const rules: FilterRule[] = [
      { field: 'revenueGrowthYoy', operator: '>', value: 0.10 },
      { field: 'debtToEquity',     operator: '<', value: 0.5  }, // fails: 0.8 < 0.5 is false
    ];
    const result = evaluateStock(rules, stockData);
    expect(result.passed).toBe(false);
    expect(result.failedRules).toHaveLength(1);
    expect(result.failedRules[0].field).toBe('debtToEquity');
  });

  it('fails when field is null', () => {
    const rules: FilterRule[] = [
      { field: 'netMargin', operator: '>', value: 0.10 },
    ];
    const result = evaluateStock(rules, { ...stockData, netMargin: null });
    expect(result.passed).toBe(false);
  });

  it('supports all operators', () => {
    expect(evaluateStock([{ field: 'compositeScore', operator: '>=', value: 72 }], stockData).passed).toBe(true);
    expect(evaluateStock([{ field: 'compositeScore', operator: '<=', value: 72 }], stockData).passed).toBe(true);
    expect(evaluateStock([{ field: 'compositeScore', operator: '==', value: 72 }], stockData).passed).toBe(true);
    expect(evaluateStock([{ field: 'compositeScore', operator: '!=', value: 50 }], stockData).passed).toBe(true);
  });

  it('handles empty rules array', () => {
    const result = evaluateStock([], stockData);
    expect(result.passed).toBe(true);
    expect(result.passedRules).toHaveLength(0);
  });
});
