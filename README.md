# Stock Dip Analysis Backend

Simple TypeScript/Express MVP that uses Finnhub and an Alpha Vantage candle fallback to flag whether a well-known stock is in a dip worth researching further.

This API is intentionally conservative. It does not claim a stock is a guaranteed buy, and it does not include valuation, full fundamentals, or analyst ratings yet.

## Data Sources

The MVP pulls only:

- Finnhub quote data
- Finnhub historical daily candles, with Alpha Vantage daily candles as a fallback
- RSI, calculated locally from candle closes when Finnhub's RSI endpoint is unavailable
- Finnhub company news headlines

## Scoring

Scores are capped at 100:

| Rule | Points |
| --- | ---: |
| Dip percentage is greater than 5% from the recent 20-day or 50-day high | 30 |
| Current price is above SMA50 | 25 |
| RSI is below 35 | 20 |
| No obvious bad-news keyword is found in recent headlines | 25 |

Labels:

- `GOOD DIP`: score >= 75
- `WATCH`: score >= 50
- `AVOID`: score < 50

## Quick Start

```bash
npm install
cp .env.example .env
```

Add your Finnhub key. Add an Alpha Vantage key too if Finnhub blocks historical candles for your key:

```bash
FINNHUB_API_KEY=your_key_here
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key_here
PORT=3000
```

Alpha Vantage's free key signup is here:

```text
https://www.alphavantage.co/support/#api-key
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

## API

### Health

```bash
GET /api/v1/health
```

### Dip Analysis

```bash
GET /api/v1/dip/:symbol
GET /api/v1/stock/:symbol
```

Example:

```bash
curl http://localhost:3000/api/v1/dip/AAPL
```

Example response shape:

```json
{
  "ticker": "AAPL",
  "currentPrice": 189.42,
  "dailyPercentChange": -1.21,
  "recentHigh": 199.62,
  "recentHighWindow": 50,
  "dipPercentage": 5.11,
  "sma20": 191.25,
  "sma50": 184.76,
  "trendDirection": "UPTREND",
  "rsi": 34.8,
  "latestNewsHeadlines": [
    {
      "headline": "Example headline",
      "source": "Example Source",
      "url": "https://example.com",
      "datetime": 1710000000,
      "summary": "Example summary"
    }
  ],
  "badNewsFlag": false,
  "score": 100,
  "label": "GOOD DIP",
  "explanation": "This is a GOOD DIP research signal, not a buy recommendation.",
  "disclaimer": "Research signal only. This is not financial advice and does not predict that the stock will go up.",
  "dataWarnings": []
}
```

## Notes

- `trendDirection` is based on current price, SMA20, and SMA50.
- `recentHighWindow` uses 50 trading candles when available, otherwise 20, otherwise the available candle count.
- Alpha Vantage fallback uses `TIME_SERIES_DAILY` JSON data and the backend computes SMA/RSI locally from those candles.
- `badNewsFlag` is a simple keyword scan against the latest headlines and summaries. It is deliberately basic and should be expanded later.
- Responses are cached in memory for short periods to reduce Finnhub API usage.
