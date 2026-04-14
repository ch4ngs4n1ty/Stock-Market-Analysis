# Stock Research Backend

Production-grade stock research and analysis backend built with Node.js, TypeScript, PostgreSQL, Redis, and Socket.IO.

## Stack

- **Runtime**: Node.js 20 + TypeScript
- **Framework**: Express
- **Database**: PostgreSQL 15
- **Cache**: Redis 7
- **Real-time**: Socket.IO
- **HTTP client**: Axios (with retry)
- **Data sources**: Finnhub, SEC EDGAR, Alpha Vantage (fallback)

---

## Quick Start

### 1. Prerequisites

- Node.js 20+
- Docker & Docker Compose (for Postgres + Redis)
- Finnhub API key (free tier works): https://finnhub.io

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env and add your FINNHUB_API_KEY
```

### 4. Start infrastructure

```bash
docker-compose up -d postgres redis
```

### 5. Run migrations

```bash
psql -U postgres -d stock_research -f migrations/init.sql
```

Or if using Docker:
```bash
docker exec -i stock_research_postgres psql -U postgres -d stock_research < migrations/init.sql
```

### 6. Seed initial stocks

```bash
npm run seed
```

### 7. Start the server

```bash
npm run dev
```

The server starts on `http://localhost:3000`.

---

## API Reference

### Stock Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/stock/:symbol` | Price + fundamentals + score |
| GET | `/api/v1/stock/:symbol/metrics` | Full research metrics |
| GET | `/api/v1/stock/:symbol/filings` | SEC filings |
| GET | `/api/v1/stock/:symbol/candles?resolution=D` | OHLCV candles |
| POST | `/api/v1/stock/:symbol/evaluate` | Evaluate rules against one stock |

### Screening

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/screen` | Screen stocks by rules |
| GET | `/api/v1/stocks` | List all tracked stocks |
| POST | `/api/v1/stocks` | Add a stock to track |

### Watchlist

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/watchlist` | Get watchlist (requires `x-user-id` header) |
| POST | `/api/v1/watchlist` | Add to watchlist |

### Utility

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |

---

## Screening Example

```bash
curl -X POST http://localhost:3000/api/v1/screen \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      { "field": "revenueGrowthYoy", "operator": ">",  "value": 0.10 },
      { "field": "grossMargin",      "operator": ">",  "value": 0.40 },
      { "field": "debtToEquity",     "operator": "<",  "value": 1.0  },
      { "field": "relativeVolume",   "operator": ">=", "value": 1.5  }
    ],
    "limit": 20,
    "minScore": 60
  }'
```

## Parameter Evaluation Example

```bash
curl -X POST http://localhost:3000/api/v1/stock/AAPL/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      { "field": "revenueGrowthYoy", "operator": ">", "value": 0.05 },
      { "field": "grossMargin",      "operator": ">", "value": 0.40 },
      { "field": "debtToEquity",     "operator": "<", "value": 1.0  }
    ]
  }'
```

---

## WebSocket Usage

Connect to the WebSocket server and subscribe to price updates:

```javascript
const socket = io('http://localhost:3000');

// Subscribe to symbols
socket.emit('subscribe', ['AAPL', 'MSFT', 'NVDA']);

// Listen for price updates (every 15s)
socket.on('price_update', ({ symbol, data, ts }) => {
  console.log(`${symbol}: $${data.price} (${data.changePct?.toFixed(2)}%)`);
});

// Listen for score updates
socket.on('score_update', ({ symbol, score }) => {
  console.log(`${symbol} research score: ${score.compositeScore}`);
});

// Unsubscribe
socket.emit('unsubscribe', ['AAPL']);
```

---

## Research Scoring

Stocks are scored 0–100 based on four dimensions:

| Dimension | Weight | Key Metrics |
|-----------|--------|-------------|
| Profitability | 35% | Gross margin, operating margin, net margin, ROE |
| Growth | 30% | Revenue growth YoY, EPS growth YoY |
| Leverage | 20% | Debt/equity, current ratio |
| Momentum | 15% | Relative volume, distance from 52w high, above 200D MA |

---

## Available Screening Fields

**Market data**: `price`, `changePct`, `volume`, `relativeVolume`, `distFrom52wHigh`, `ma50d`, `ma200d`, `high52w`

**Fundamentals**: `revenueGrowthYoy`, `epsGrowthYoy`, `grossMargin`, `operatingMargin`, `netMargin`, `roe`, `roa`, `debtToEquity`, `currentRatio`, `freeCashFlow`, `peRatio`, `psRatio`

**Scores**: `compositeScore`, `growthScore`, `profitabilityScore`, `leverageScore`, `momentumScore`

---

## Project Structure

```
src/
├── config/          # DB, Redis, env validation
├── modules/
│   ├── market-data/ # Price, candles, moving averages
│   ├── fundamentals/# EPS, margins, ROE etc.
│   ├── filings/     # SEC EDGAR 10-K, 10-Q, 8-K
│   ├── research/    # Scoring engine
│   └── screening/   # Filter + rank engine
├── shared/
│   ├── cache/       # Redis wrapper
│   ├── normalizer/  # Raw API → unified schema
│   ├── http/        # Axios client with retry
│   └── utils/       # Math helpers
├── jobs/            # Poller + daily refresh jobs
├── gateway/         # Socket.IO WebSocket server
├── middleware/       # Error handler, rate limiter
└── routes.ts        # All REST endpoints
```

---

## Running Tests

```bash
npm test              # all tests
npm run test:unit     # unit tests only
```

---

## Production Deployment

```bash
# Build
npm run build

# Start (ensure .env is configured)
npm start

# Or via Docker Compose (full stack)
docker-compose up --build
```
