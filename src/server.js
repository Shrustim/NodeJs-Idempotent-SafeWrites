import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './db.js';

const app = express();
app.use(express.json({ limit: '16kb' }));

// LOCAL PRACTICE ONLY. In production derive this from authenticated identity.
const CLIENT_ID = 'demo-client';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const orderFields = `
  id, client_id AS "clientId", external_order_id AS "externalOrderId",
  sku, quantity, price_cents AS "priceCents", note, version
`;

function validSku(value) {
  if (typeof value !== 'string') return null;
  const sku = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,30}$/.test(sku) ? sku : null;
}

function validExternalOrderId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
    ? value : null;
}

function requestFingerprint(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// One transaction contains the dedupe record and its business write.
async function runIdempotent(req, res, fingerprintData, businessOperation) {
  const key = req.get('Idempotency-Key');
  if (!key || !/^[a-zA-Z0-9._:-]{1,120}$/.test(key)) {
    return sendError(res, 400, 'Provide Idempotency-Key (1-120 letters/numbers/._:-)');
  }
  const hash = requestFingerprint({ method: 'POST', path: '/orders', ...fingerprintData });
  const db = await pool.connect();
  let transactionOpen = false;

  try {
    await db.query('BEGIN');
    transactionOpen = true;

    const inserted = await db.query(
      `INSERT INTO idempotency_requests
         (client_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [CLIENT_ID, key, hash]
    );

    if (inserted.rowCount === 0) {
      const previous = await db.query(
        `SELECT request_hash, status_code, response_body
         FROM idempotency_requests
         WHERE client_id = $1 AND idempotency_key = $2`,
        [CLIENT_ID, key]
      );
      if (previous.rowCount === 0 || previous.rows[0].status_code === null) {
        throw new Error('Idempotency record unexpectedly missing or incomplete');
      }
      await db.query('COMMIT');
      transactionOpen = false;

      const old = previous.rows[0];
      if (old.request_hash.trim() !== hash) {
        return sendError(res, 409, 'Idempotency-Key reused with different request data');
      }
      res.set('Idempotency-Replayed', 'true');
      return res.status(old.status_code).json(old.response_body);
    }

    const outcome = await businessOperation(db);
    if (outcome.retry) {
      // NEVER cache a temporary busy response. The same key must remain reusable.
      await db.query('ROLLBACK');
      transactionOpen = false;
      res.set('Retry-After', '1');
      return sendError(res, 503, 'This order is being processed; retry with the same key');
    }

    await db.query(
      `UPDATE idempotency_requests
       SET status_code = $3, response_body = $4::jsonb
       WHERE client_id = $1 AND idempotency_key = $2`,
      [CLIENT_ID, key, outcome.status, JSON.stringify(outcome.body)]
    );
    await db.query('COMMIT');
    transactionOpen = false;
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    if (transactionOpen) {
      try { await db.query('ROLLBACK'); } catch (rollbackError) { console.error(rollbackError); }
    }
    console.error('Safe write failed:', error);
    return sendError(res, 500, 'Unexpected database error');
  } finally {
    db.release();
  }
}

// 1) Idempotent creation, business deduplication, stock safety and advisory locking.
app.post('/orders', async (req, res) => {
  const externalOrderId = validExternalOrderId(req.body?.externalOrderId);
  const sku = validSku(req.body?.sku);
  const quantity = req.body?.quantity;
  if (!externalOrderId || !sku || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return sendError(res, 400, 'Expected externalOrderId, sku and quantity (1-50)');
  }

  return runIdempotent(req, res, { externalOrderId, sku, quantity }, async (db) => {
    const lock = await db.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`,
      [`order:${CLIENT_ID}:${externalOrderId}`]
    );
    if (!lock.rows[0].acquired) return { retry: true };

    // Different Idempotency-Key, but same business order: also deduplicated.
    const existing = await db.query(
      `SELECT ${orderFields} FROM orders
       WHERE client_id = $1 AND external_order_id = $2`,
      [CLIENT_ID, externalOrderId]
    );
    if (existing.rowCount > 0) {
      const order = existing.rows[0];
      if (order.sku !== sku || order.quantity !== quantity) {
        return { status: 409, body: { error: 'externalOrderId already exists with different order details' } };
      }
      return { status: 200, body: order };
    }

    // Atomic conditional UPDATE prevents stock going below zero under concurrency.
    const reserved = await db.query(
      `UPDATE products SET stock = stock - $1
       WHERE sku = $2 AND stock >= $1
       RETURNING price_cents AS "priceCents"`,
      [quantity, sku]
    );
    if (reserved.rowCount === 0) {
      const known = await db.query('SELECT sku FROM products WHERE sku = $1', [sku]);
      if (known.rowCount === 0) {
        return { status: 404, body: { error: 'Product not found' } };
      }
      return { status: 409, body: { error: 'Insufficient stock' } };
    }

    const created = await db.query(
      `INSERT INTO orders
        (id, client_id, external_order_id, sku, quantity, price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${orderFields}`,
      [randomUUID(), CLIENT_ID, externalOrderId, sku, quantity, reserved.rows[0].priceCents]
    );
    return { status: 201, body: created.rows[0] };
  });
});

// 2) Read product (inspect current stock).
app.get('/products/:sku', async (req, res) => {
  const sku = validSku(req.params.sku);
  if (!sku) return sendError(res, 400, 'Invalid SKU');
  try {
    const result = await pool.query(
      `SELECT sku, price_cents AS "priceCents", stock FROM products WHERE sku = $1`,
      [sku]
    );
    return result.rowCount ? res.json(result.rows[0]) : sendError(res, 404, 'Product not found');
  } catch (error) {
    console.error(error);
    return sendError(res, 500, 'Database error');
  }
});

// 3) Idempotent PUT with PostgreSQL UPSERT: set the absolute price; never reset stock.
app.put('/products/:sku', async (req, res) => {
  const sku = validSku(req.params.sku);
  const priceCents = req.body?.priceCents;
  if (!sku || !Number.isInteger(priceCents) || priceCents < 1 || priceCents > 10_000_000) {
    return sendError(res, 400, 'Expected valid SKU and priceCents (positive integer)');
  }
  try {
    const result = await pool.query(
      `INSERT INTO products (sku, price_cents, stock)
       VALUES ($1, $2, 0)
       ON CONFLICT (sku)
       DO UPDATE SET price_cents = EXCLUDED.price_cents
       RETURNING sku, price_cents AS "priceCents", stock`,
      [sku, priceCents]
    );
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, 'Database error');
  }
});

// 4) Read order and version.
app.get('/orders/:id', async (req, res) => {
  if (!uuidPattern.test(req.params.id)) return sendError(res, 400, 'Invalid order ID');
  try {
    const result = await pool.query(
      `SELECT ${orderFields} FROM orders WHERE id = $1 AND client_id = $2`,
      [req.params.id, CLIENT_ID]
    );
    return result.rowCount ? res.json(result.rows[0]) : sendError(res, 404, 'Order not found');
  } catch (error) {
    console.error(error);
    return sendError(res, 500, 'Database error');
  }
});

// 5) Optimistic version check: only one writer may update version N.
app.patch('/orders/:id/note', async (req, res) => {
  if (!uuidPattern.test(req.params.id)) return sendError(res, 400, 'Invalid order ID');
  const note = req.body?.note;
  const expectedVersion = req.body?.expectedVersion;
  if (typeof note !== 'string' || note.length > 500 ||
      !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return sendError(res, 400, 'Expected note (max 500 chars) and expectedVersion (positive integer)');
  }
  try {
    const updated = await pool.query(
      `UPDATE orders SET note = $1, version = version + 1
       WHERE id = $2 AND client_id = $3 AND version = $4
       RETURNING ${orderFields}`,
      [note, req.params.id, CLIENT_ID, expectedVersion]
    );
    if (updated.rowCount) return res.json(updated.rows[0]);

    const current = await pool.query(
      'SELECT version FROM orders WHERE id = $1 AND client_id = $2',
      [req.params.id, CLIENT_ID]
    );
    return current.rowCount
      ? res.status(409).json({ error: 'Version conflict; fetch latest order', currentVersion: current.rows[0].version })
      : sendError(res, 404, 'Order not found');
  } catch (error) {
    console.error(error);
    return sendError(res, 500, 'Database error');
  }
});

// Malformed JSON is a client error, not a server crash.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return sendError(res, 400, 'Invalid JSON body');
  }
  console.error(error);
  return sendError(res, 500, 'Unexpected server error');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Safe writes practice API running at http://localhost:${port}`));
