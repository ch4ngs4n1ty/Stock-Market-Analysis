import { db, testConnection } from '../src/config/database';
import { connectRedis } from '../src/config/redis';

const SEED_STOCKS = [
  { symbol: 'AAPL',  name: 'Apple Inc.',               exchange: 'NASDAQ', sector: 'Technology',         industry: 'Consumer Electronics' },
  { symbol: 'MSFT',  name: 'Microsoft Corporation',    exchange: 'NASDAQ', sector: 'Technology',         industry: 'Software—Infrastructure' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',             exchange: 'NASDAQ', sector: 'Technology',         industry: 'Internet Content & Information' },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',           exchange: 'NASDAQ', sector: 'Consumer Cyclical',  industry: 'Internet Retail' },
  { symbol: 'NVDA',  name: 'NVIDIA Corporation',        exchange: 'NASDAQ', sector: 'Technology',         industry: 'Semiconductors' },
  { symbol: 'META',  name: 'Meta Platforms Inc.',       exchange: 'NASDAQ', sector: 'Technology',         industry: 'Internet Content & Information' },
  { symbol: 'TSLA',  name: 'Tesla Inc.',                exchange: 'NASDAQ', sector: 'Consumer Cyclical',  industry: 'Auto Manufacturers' },
  { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',      exchange: 'NYSE',   sector: 'Financial Services', industry: 'Banks—Diversified' },
  { symbol: 'V',     name: 'Visa Inc.',                 exchange: 'NYSE',   sector: 'Financial Services', industry: 'Credit Services' },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',         exchange: 'NYSE',   sector: 'Healthcare',         industry: 'Drug Manufacturers—General' },
  { symbol: 'WMT',   name: 'Walmart Inc.',              exchange: 'NYSE',   sector: 'Consumer Defensive', industry: 'Discount Stores' },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',      exchange: 'NYSE',   sector: 'Consumer Defensive', industry: 'Household & Personal Products' },
  { symbol: 'MA',    name: 'Mastercard Incorporated',   exchange: 'NYSE',   sector: 'Financial Services', industry: 'Credit Services' },
  { symbol: 'HD',    name: 'The Home Depot Inc.',       exchange: 'NYSE',   sector: 'Consumer Cyclical',  industry: 'Home Improvement Retail' },
  { symbol: 'COST',  name: 'Costco Wholesale Corp.',    exchange: 'NASDAQ', sector: 'Consumer Defensive', industry: 'Discount Stores' },
  { symbol: 'ADBE',  name: 'Adobe Inc.',                exchange: 'NASDAQ', sector: 'Technology',         industry: 'Software—Application' },
  { symbol: 'CRM',   name: 'Salesforce Inc.',           exchange: 'NYSE',   sector: 'Technology',         industry: 'Software—Application' },
  { symbol: 'NOW',   name: 'ServiceNow Inc.',           exchange: 'NYSE',   sector: 'Technology',         industry: 'Software—Application' },
  { symbol: 'SNOW',  name: 'Snowflake Inc.',            exchange: 'NYSE',   sector: 'Technology',         industry: 'Software—Application' },
  { symbol: 'NET',   name: 'Cloudflare Inc.',           exchange: 'NYSE',   sector: 'Technology',         industry: 'Software—Infrastructure' },
];

async function seed() {
  await connectRedis();
  await testConnection();

  console.log(`Seeding ${SEED_STOCKS.length} stocks…`);

  for (const stock of SEED_STOCKS) {
    await db.query(
      `INSERT INTO stocks (symbol, name, exchange, sector, industry)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (symbol) DO UPDATE SET
         name     = EXCLUDED.name,
         exchange = EXCLUDED.exchange,
         sector   = EXCLUDED.sector,
         industry = EXCLUDED.industry`,
      [stock.symbol, stock.name, stock.exchange, stock.sector, stock.industry]
    );
    console.log(`  ✓ ${stock.symbol}`);
  }

  console.log('\n✅ Seed complete');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
