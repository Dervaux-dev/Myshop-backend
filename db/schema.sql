-- MyShop PostgreSQL schema - fully idempotent, safe to re-run.
--
-- gen_random_uuid() is built into PostgreSQL core (since v13). On older
-- servers the pgcrypto extension is created below, so the schema still works
-- there too.

-- 0. Make sure gen_random_uuid() exists (no-op on PostgreSQL >= 13)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid'
    ) THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
    END IF;
END $$;

-- 1. Businesses (Tenants)
CREATE TABLE IF NOT EXISTS businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'RWF',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users (Scoped per business)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    username VARCHAR(80) NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'staff')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_business_username UNIQUE (business_id, username)
);

-- 3. Products (Inventory scoped per business)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    barcode VARCHAR(100),
    name VARCHAR(200) NOT NULL,
    price NUMERIC(14, 2) NOT NULL CHECK (price >= 0),
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0), -- Prevents negative stock
    category VARCHAR(100) NOT NULL DEFAULT 'General',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_business_product_name UNIQUE (business_id, name)
);

-- 4. Sales Header
CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sold_by UUID REFERENCES users(id) ON DELETE SET NULL,
    sold_by_name VARCHAR(100) NOT NULL DEFAULT 'unknown',
    grand_total NUMERIC(14, 2) NOT NULL CHECK (grand_total >= 0),
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_from VARCHAR(20) NOT NULL DEFAULT 'mobile',
    status VARCHAR(20) NOT NULL DEFAULT 'synced'
);

-- 5. Sale Items (Normalized items)
CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    name VARCHAR(200) NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    price NUMERIC(14, 2) NOT NULL CHECK (price >= 0),
    subtotal NUMERIC(14, 2) NOT NULL CHECK (subtotal >= 0)
);

-- 6. Receipts (QR payment orders) - pending until the payment service confirms
CREATE TABLE IF NOT EXISTS receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    receipt_number VARCHAR(30) NOT NULL,
    payment_ref UUID NOT NULL UNIQUE,               -- Unique transaction id encoded in the QR
    sold_by UUID REFERENCES users(id) ON DELETE SET NULL,
    sold_by_name VARCHAR(100) NOT NULL DEFAULT 'unknown',
    items JSONB NOT NULL,                            -- Immutable sanitized line items at request time
    grand_total NUMERIC(14, 2) NOT NULL CHECK (grand_total >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'RWF',
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
    processor_ref VARCHAR(100),                      -- External payment-system reference
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    CONSTRAINT uq_business_receipt_number UNIQUE (business_id, receipt_number)
);

-- Link a completed sale back to the receipt that paid for it (audit trail)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS source_receipt_id UUID REFERENCES receipts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Drift guard: CREATE TABLE IF NOT EXISTS never alters an existing table, so
-- tables created by an earlier version of this schema may miss newer columns.
-- Add any that are missing. Keep this list in sync when adding columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    col record;
BEGIN
    FOR col IN
        SELECT * FROM (VALUES
            ('businesses', 'currency', 'VARCHAR(10) NOT NULL DEFAULT ''RWF'''),
            ('products',   'category', 'VARCHAR(100) NOT NULL DEFAULT ''General'''),
            ('sales',      'sold_by_name', 'VARCHAR(100) NOT NULL DEFAULT ''unknown'''),
            ('sales',      'synced_from', 'VARCHAR(20) NOT NULL DEFAULT ''mobile'''),
            ('sales',      'status', 'VARCHAR(20) NOT NULL DEFAULT ''synced'''),
            ('receipts',   'payment_ref', 'UUID NOT NULL DEFAULT gen_random_uuid()'),
            ('receipts',   'sold_by', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
            ('receipts',   'sold_by_name', 'VARCHAR(100) NOT NULL DEFAULT ''unknown'''),
            ('receipts',   'items', 'JSONB NOT NULL DEFAULT ''[]''::jsonb'),
            ('receipts',   'currency', 'VARCHAR(10) NOT NULL DEFAULT ''RWF'''),
            ('receipts',   'status', 'VARCHAR(20) NOT NULL DEFAULT ''pending'''),
            ('receipts',   'processor_ref', 'VARCHAR(100)'),
            ('receipts',   'paid_at', 'TIMESTAMPTZ')
        ) AS t(tbl, cname, cdef)
    LOOP
        IF to_regclass(format('public.%I', col.tbl)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s',
                           col.tbl, col.cname, col.cdef);
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Unique constraints required by the ON CONFLICT clauses in migrate.js.
-- CREATE TABLE IF NOT EXISTS skips tables that already exist, so a table made
-- by an older schema (without the constraint) would break seeding.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = 'users'::regclass
          AND i.indisunique
          AND i.indnkeyatts = 2
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM unnest(i.indkey::smallint[]) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE k.attnum > 0) = ARRAY['business_id', 'username']
    ) THEN
        ALTER TABLE users ADD CONSTRAINT uq_business_username UNIQUE (business_id, username);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = 'products'::regclass
          AND i.indisunique
          AND i.indnkeyatts = 2
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM unnest(i.indkey::smallint[]) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE k.attnum > 0) = ARRAY['business_id', 'name']
    ) THEN
        ALTER TABLE products ADD CONSTRAINT uq_business_product_name UNIQUE (business_id, name);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = 'receipts'::regclass
          AND i.indisunique
          AND i.indnkeyatts = 2
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM unnest(i.indkey::smallint[]) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE k.attnum > 0) = ARRAY['business_id', 'receipt_number']
    ) THEN
        ALTER TABLE receipts ADD CONSTRAINT uq_business_receipt_number UNIQUE (business_id, receipt_number);
    END IF;
END $$;

-- Indexes for high-speed queries across 30+ businesses
CREATE INDEX IF NOT EXISTS idx_products_business_name ON products(business_id, name);
CREATE INDEX IF NOT EXISTS idx_products_business_barcode ON products(business_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_business_date ON sales(business_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_business_sold_by ON sales(business_id, sold_by, date DESC);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_users_business_user ON users(business_id, username);
CREATE INDEX IF NOT EXISTS idx_receipts_business_status ON receipts(business_id, status, created_at DESC);
-- payment_ref already has an automatic index from its UNIQUE constraint.
