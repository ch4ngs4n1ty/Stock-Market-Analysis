-- ============================================================
-- Stock Research Platform - Full Database Schema
-- Run: psql -U postgres -d stock_research -f migrations/init.sql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- stocks: master registry of tracked tickers
-- ============================================================
CREATE TABLE IF NOT EXISTS stocks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      VARCHAR(10) NOT NULL UNIQUE,
  name        VARCHAR(255),
  exchange    VARCHAR(50),
  sector      VARCHAR(100),
  industry    VARCHAR(100),
  country     VARCHAR(50)  DEFAULT 'US',
  currency    VARCHAR(10)  DEFAULT 'USD',
  is_active   BOOLEAN      DEFAULT TRUE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stocks_symbol   ON stocks(symbol);
CREATE INDEX IF NOT EXISTS idx_stocks_sector   ON stocks(sector);
CREATE INDEX IF NOT EXISTS idx_stocks_active   ON stocks(is_active);

-- ============================================================
-- market_data: latest price snapshot (1 row per symbol)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_data (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id        UUID        NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  symbol          VARCHAR(10) NOT NULL,
  price           NUMERIC(18,4),
  prev_close      NUMERIC(18,4),
  change_pct      NUMERIC(8,4),
  volume          BIGINT,
  avg_volume_10d  BIGINT,
  high_52w        NUMERIC(18,4),
  low_52w         NUMERIC(18,4),
  ma_50d          NUMERIC(18,4),
  ma_200d         NUMERIC(18,4),
  relative_volume NUMERIC(8,4),
  dist_52w_high   NUMERIC(8,4),
  fetched_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(stock_id)
);

CREATE INDEX IF NOT EXISTS idx_market_data_symbol  ON market_data(symbol);
CREATE INDEX IF NOT EXISTS idx_market_data_fetched ON market_data(fetched_at);

-- ============================================================
-- price_candles: OHLCV history
-- ============================================================
CREATE TABLE IF NOT EXISTS price_candles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id    UUID        NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  symbol      VARCHAR(10) NOT NULL,
  resolution  VARCHAR(10) NOT NULL,
  open        NUMERIC(18,4),
  high        NUMERIC(18,4),
  low         NUMERIC(18,4),
  close       NUMERIC(18,4),
  volume      BIGINT,
  ts          TIMESTAMPTZ NOT NULL,
  UNIQUE(stock_id, resolution, ts)
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_ts ON price_candles(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_candles_resolution ON price_candles(resolution);

-- ============================================================
-- fundamentals: financial metrics (1 row per stock, latest)
-- ============================================================
CREATE TABLE IF NOT EXISTS fundamentals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id            UUID        NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  symbol              VARCHAR(10) NOT NULL,
  revenue_ttm         NUMERIC(20,2),
  revenue_growth_yoy  NUMERIC(8,4),
  eps_ttm             NUMERIC(10,4),
  eps_growth_yoy      NUMERIC(8,4),
  gross_margin        NUMERIC(8,4),
  operating_margin    NUMERIC(8,4),
  net_margin          NUMERIC(8,4),
  roe                 NUMERIC(8,4),
  roa                 NUMERIC(8,4),
  debt_to_equity      NUMERIC(8,4),
  current_ratio       NUMERIC(8,4),
  free_cash_flow      NUMERIC(20,2),
  fcf_yield           NUMERIC(8,4),
  pe_ratio            NUMERIC(10,4),
  ps_ratio            NUMERIC(10,4),
  pb_ratio            NUMERIC(10,4),
  period_end          DATE,
  source              VARCHAR(50),
  fetched_at          TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(stock_id)
);

CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol ON fundamentals(symbol);

-- ============================================================
-- filings: SEC EDGAR filing index
-- ============================================================
CREATE TABLE IF NOT EXISTS filings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id      UUID        NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  symbol        VARCHAR(10) NOT NULL,
  form_type     VARCHAR(20) NOT NULL,
  filed_at      TIMESTAMPTZ NOT NULL,
  period_end    DATE,
  accession_no  VARCHAR(30) UNIQUE,
  filing_url    TEXT,
  description   TEXT,
  fetched_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_filings_symbol_form ON filings(symbol, form_type);
CREATE INDEX IF NOT EXISTS idx_filings_filed_at    ON filings(filed_at DESC);

-- ============================================================
-- research_scores: computed composite scores
-- ============================================================
CREATE TABLE IF NOT EXISTS research_scores (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id            UUID        NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  symbol              VARCHAR(10) NOT NULL,
  composite_score     NUMERIC(5,2),
  growth_score        NUMERIC(5,2),
  profitability_score NUMERIC(5,2),
  leverage_score      NUMERIC(5,2),
  momentum_score      NUMERIC(5,2),
  computed_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stock_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_symbol    ON research_scores(symbol);
CREATE INDEX IF NOT EXISTS idx_scores_composite ON research_scores(composite_score DESC);

-- ============================================================
-- screening_results: cached screen outputs
-- ============================================================
CREATE TABLE IF NOT EXISTS screening_results (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  filter_hash  VARCHAR(64) NOT NULL,
  filters      JSONB       NOT NULL,
  results      JSONB       NOT NULL,
  result_count INTEGER,
  computed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screening_hash ON screening_results(filter_hash);
CREATE INDEX IF NOT EXISTS idx_screening_at   ON screening_results(computed_at DESC);

-- ============================================================
-- user_watchlists
-- ============================================================
CREATE TABLE IF NOT EXISTS user_watchlists (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID        NOT NULL,
  symbol    VARCHAR(10) NOT NULL,
  added_at  TIMESTAMPTZ DEFAULT NOW(),
  notes     TEXT,
  UNIQUE(user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user ON user_watchlists(user_id);

-- ============================================================
-- updated_at auto-trigger for stocks table
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stocks_updated_at ON stocks;
CREATE TRIGGER stocks_updated_at
  BEFORE UPDATE ON stocks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
