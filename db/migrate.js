const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const db = require('./index');

// Arbitrary but fixed key so concurrent `npm run migrate` calls serialize
// instead of racing each other on CREATE TABLE / seed inserts.
const MIGRATION_LOCK_KEY = 748392015;

function sslOption() {
  if (process.env.NODE_ENV !== 'production') return false;
  // Same policy as db/index.js: verify certificates unless the platform
  // explicitly opts out (Render's CA is not in the Node trust store).
  return process.env.PG_SSL_REJECT_UNAUTHORIZED === 'false'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };
}

function targetDatabaseName() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      const name = parsed.pathname.replace(/^\//, '');
      if (name) return name;
    } catch (_) {
      /* fall through to PGDATABASE */
    }
  }
  return process.env.PGDATABASE || 'myshop';
}

/**
 * Make sure the target database exists. PostgreSQL cannot connect to a
 * database that was never created, which is the most common fresh-setup
 * failure, so we create it up-front against the maintenance database.
 */
async function ensureDatabase() {
  const dbName = targetDatabaseName();
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    console.log(`ℹ️  Database "${dbName}" - skipping auto-create (unexpected name).`);
    return;
  }

  const url = process.env.DATABASE_URL;
  let config;
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error(`DATABASE_URL is not a valid URL: ${err.message}`);
    }
    config = {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      ssl: sslOption(),
    };
  } else {
    config = {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT, 10) || 5432,
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
    };
  }

  const admin = new Pool({ ...config, database: 'postgres', max: 1, connectionTimeoutMillis: 10000 });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`✅ Created database "${dbName}".`);
    } else {
      console.log(`ℹ️  Database "${dbName}" already exists.`);
    }
  } catch (err) {
    if (err.code === '23505') {
      // Another migration created it between our check and CREATE DATABASE.
      console.log(`ℹ️  Database "${dbName}" was created concurrently.`);
    } else {
      // Not fatal: the real connection below will report a precise error if
      // the database is genuinely unreachable/missing.
      console.warn(`⚠️  Could not verify/create database "${dbName}" (${err.message}). Continuing...`);
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

async function migrate() {
  console.log('🚀 Running PostgreSQL schema migration...');
  let phase = 'connect';

  try {
    await ensureDatabase();

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    // One dedicated session for the whole run: the advisory lock only lives
    // on this connection, and DDL + seeds stay serialized behind it.
    const client = await db.getClient();

    try {
      phase = 'advisory lock';
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      phase = 'schema DDL';
      await client.query(sql);
      console.log('✅ PostgreSQL Schema & Indexes applied successfully.');

      phase = 'seeding';
      await client.query('BEGIN');
      try {
        // 1. Ensure default initial business exists
        const businessRes = await client.query(
          "SELECT id, name FROM businesses WHERE name = 'Main Shop' LIMIT 1"
        );
        let businessId;

        if (businessRes.rows.length === 0) {
          const newBiz = await client.query(
            "INSERT INTO businesses (name, currency) VALUES ('Main Shop', 'RWF') RETURNING id, name"
          );
          businessId = newBiz.rows[0].id;
          console.log(`✅ Created default business: ${newBiz.rows[0].name} (${businessId})`);
        } else {
          businessId = businessRes.rows[0].id;
          console.log(`ℹ️  Using existing business: ${businessRes.rows[0].name} (${businessId})`);
        }

        // 2. Ensure default admin & staff users exist for this business
        const adminHash = await bcrypt.hash('admin123', 10);
        const staffHash = await bcrypt.hash('staff123', 10);

        await client.query(
          `INSERT INTO users (business_id, username, password_hash, role)
           VALUES ($1, 'admin', $2, 'admin')
           ON CONFLICT (business_id, username) DO NOTHING`,
          [businessId, adminHash]
        );

        await client.query(
          `INSERT INTO users (business_id, username, password_hash, role)
           VALUES ($1, 'staff', $2, 'staff')
           ON CONFLICT (business_id, username) DO NOTHING`,
          [businessId, staffHash]
        );
        console.log('✅ Default users seeded (admin / staff).');

        // 3. Seed sample initial products if none exist
        const prodCount = await client.query(
          'SELECT COUNT(*)::int as count FROM products WHERE business_id = $1',
          [businessId]
        );
        if (prodCount.rows[0].count === 0) {
          await client.query(
            `INSERT INTO products (business_id, barcode, name, price, stock, category) VALUES
             ($1, '1001', 'Inyange Milk 500ml', 800.00, 25, 'Beverages'),
             ($1, '1002', 'Pain de Ble Bread', 1200.00, 15, 'Bakery'),
             ($1, '1003', 'Sugar 1kg', 1500.00, 40, 'Groceries')
             ON CONFLICT (business_id, name) DO NOTHING`,
            [businessId]
          );
          console.log('✅ Seeded sample products for Main Shop.');
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      phase = 'release lock';
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }

    console.log('🎉 Migration completed successfully!');
    await db.pool.end().catch(() => {});
    process.exit(0);
  } catch (error) {
    console.error(`❌ Migration failed during "${phase}":`, error.message);
    if (error.code) console.error(`   SQLSTATE: ${error.code}`);
    await db.pool.end().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
