const { Pool } = require('pg');
const path = require('path');

// Load .env from the project root regardless of the current working directory,
// so `node db/migrate.js` works from any folder.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectionString = process.env.DATABASE_URL;

// TLS for hosted Postgres. Verification is ON by default; platforms whose
// certificate is not in the Node trust store (e.g. Render) must opt out
// explicitly with PG_SSL_REJECT_UNAUTHORIZED=false instead of everyone
// shipping verification disabled.
const ssl =
  process.env.NODE_ENV === 'production'
    ? process.env.PG_SSL_REJECT_UNAUTHORIZED === 'false'
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true }
    : false;

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl,
        max: 20, // Max concurrent connections per worker
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
    : {
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT, 10) || 5432,
        database: process.env.PGDATABASE || 'myshop',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  pool,
  /**
   * Execute a single query against the pool.
   */
  query: (text, params) => pool.query(text, params),

  /**
   * Acquire a client from the pool for manual multi-statement transactions.
   */
  getClient: () => pool.connect(),

  /**
   * Helper to run an entire callback inside an atomic transaction.
   */
  async withTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
