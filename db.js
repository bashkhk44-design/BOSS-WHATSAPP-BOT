const { Pool } = require('pg');
const crypto = require('crypto');

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

function getEncryptionKey() {
  const value = process.env.BOTS_ENCRYPTION_KEY || '';

  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('BOTS_ENCRYPTION_KEY غير مضبوط بشكل صحيح في Render');
  }

  return Buffer.from(value, 'hex');
}

function encryptToken(token) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    fingerprint: crypto
      .createHmac('sha256', key)
      .update(token)
      .digest('hex')
  };
}

function decryptToken(record) {
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.token_iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(record.token_auth_tag, 'hex'));

  let decrypted = decipher.update(
    record.token_ciphertext,
    'base64',
    'utf8'
  );

  decrypted += decipher.final('utf8');
  return decrypted;
}

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

  await pool.query(`
    ALTER TABLE telegram_bots
    ADD COLUMN IF NOT EXISTS token_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS token_iv TEXT,
    ADD COLUMN IF NOT EXISTS token_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS token_fingerprint TEXT
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    telegram_bots_token_fingerprint_idx
    ON telegram_bots(token_fingerprint)
    WHERE token_fingerprint IS NOT NULL
  `);

  console.log('Neon PostgreSQL connected; telegram_bots table ready');
}

async function insertTelegramBot({ name, username, token }) {
  const encrypted = encryptToken(token);

  const result = await pool.query(
    `INSERT INTO telegram_bots
      (name, username, active, token_ciphertext,
       token_iv, token_auth_tag, token_fingerprint)
     VALUES ($1, $2, TRUE, $3, $4, $5, $6)
     RETURNING id, name, username, active, created_at`,
    [
      name,
      username,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.fingerprint
    ]
  );

  return result.rows[0];
}


async function getActiveTelegramBots() {
  const result = await pool.query(`
    SELECT id, name, username, token_ciphertext,
           token_iv, token_auth_tag
    FROM telegram_bots
    WHERE active = TRUE
      AND token_ciphertext IS NOT NULL
    ORDER BY id ASC
  `);

  return result.rows.map(record => ({
    ...record,
    token: decryptToken(record)
  }));
}

module.exports = {
  pool,
  initDatabase,
  insertTelegramBot,
  getActiveTelegramBots,
  decryptToken
};
