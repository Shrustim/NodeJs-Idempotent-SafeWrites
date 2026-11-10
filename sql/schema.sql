-- Run in the safe_writes_practice database (PostgreSQL 14+).
CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    client_id TEXT NOT NULL,
    external_order_id TEXT NOT NULL,
    sku TEXT NOT NULL REFERENCES products(sku),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, external_order_id)
);

CREATE TABLE IF NOT EXISTS idempotency_requests (
    client_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status_code INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, idempotency_key),
    CHECK ((status_code IS NULL AND response_body IS NULL)
       OR (status_code IS NOT NULL AND response_body IS NOT NULL))
);

-- Safe to rerun; keep existing stock untouched.
INSERT INTO products (sku, price_cents, stock)
VALUES ('COFFEE', 15000, 10), ('TEA', 5000, 10)
ON CONFLICT (sku) DO NOTHING;
