const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL غير مضبوط في متغيرات البيئة');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bots (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('Neon PostgreSQL connected; telegram_bots table ready');
}

module.exports = { pool, initDatabase };
