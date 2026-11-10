import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const sku = `T${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
const externalId = (label) => `${label}-${randomUUID().slice(0, 8)}`;
let initialOrderId;

before(async () => {
  await pool.query('INSERT INTO products (sku, price_cents, stock) VALUES ($1, $2, $3)', [sku, 12500, 5]);
});
after(async () => { await pool.end(); });

async function postOrder(key, body) {
  const result = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: result.status, headers: result.headers, body: await result.json() };
}

async function postWithBusyRetry(key, body) {
  for (let i = 0; i < 10; i++) {
    const response = await postOrder(key, body);
    if (response.status !== 503) return response;
    assert.equal(response.headers.get('retry-after'), '1');
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  throw new Error('Order remained busy after multiple retries');
}

test('same Idempotency-Key sent concurrently creates one order, decrements stock once', async () => {
  const key = randomUUID();
  const body = { externalOrderId: externalId('same-key'), sku, quantity: 1 };
  const responses = await Promise.all(Array.from({ length: 12 }, () => postOrder(key, body)));
  assert.ok(responses.every((r) => r.status === 201));
  assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
  assert.equal(responses.filter((r) => r.headers.get('idempotency-replayed') === 'true').length, 11);
  initialOrderId = responses[0].body.id;
  const stock = await pool.query('SELECT stock FROM products WHERE sku = $1', [sku]);
  assert.equal(stock.rows[0].stock, 4);

  const misuse = await postOrder(key, { ...body, quantity: 2 });
  assert.equal(misuse.status, 409);
});

test('different keys, same externalOrderId, still creates only one order', async () => {
  const body = { externalOrderId: externalId('business-key'), sku, quantity: 1 };
  const responses = await Promise.all(Array.from({ length: 8 }, () => postWithBusyRetry(randomUUID(), body)));
  assert.ok(responses.every((r) => [200, 201].includes(r.status)));
  assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
  const count = await pool.query(
    'SELECT COUNT(*)::int AS count FROM orders WHERE client_id = $1 AND external_order_id = $2',
    ['demo-client', body.externalOrderId]
  );
  assert.equal(count.rows[0].count, 1);
  const stock = await pool.query('SELECT stock FROM products WHERE sku = $1', [sku]);
  assert.equal(stock.rows[0].stock, 3);
});

test('UPsert PUT can be repeated without changing stock', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${BASE_URL}/products/${sku}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceCents: 13500 }),
    });
    assert.equal(response.status, 200);
    const product = await response.json();
    assert.equal(product.priceCents, 13500);
    assert.equal(product.stock, 3);
  }
});

test('optimistic version updates: one succeeds, stale update returns 409', async () => {
  const updates = await Promise.all(['Note A', 'Note B'].map(async (note) => {
    const result = await fetch(`${BASE_URL}/orders/${initialOrderId}/note`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, expectedVersion: 1 }),
    });
    return { status: result.status, body: await result.json() };
  }));
  assert.deepEqual(updates.map((x) => x.status).sort(), [200, 409]);
  assert.equal(updates.find((x) => x.status === 200).body.version, 2);
  assert.equal(updates.find((x) => x.status === 409).body.currentVersion, 2);
});

test('advisory lock contention sends 503 Retry-After; same key works after release', async () => {
  const body = { externalOrderId: externalId('busy'), sku, quantity: 1 };
  const key = randomUUID();
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`order:demo-client:${body.externalOrderId}`]);
    const busy = await postOrder(key, body);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '1');
    await blocker.query('COMMIT');
    const retried = await postOrder(key, body);
    assert.equal(retried.status, 201);
  } finally {
    try { await blocker.query('ROLLBACK'); } catch {}
    blocker.release();
  }
});

test('out-of-stock business conflict is stored and replays consistently', async () => {
  const key = randomUUID();
  const body = { externalOrderId: externalId('no-stock'), sku, quantity: 50 };
  const first = await postOrder(key, body);
  assert.equal(first.status, 409);
  assert.equal(first.body.error, 'Insufficient stock');
  const repeated = await postOrder(key, body);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.headers.get('idempotency-replayed'), 'true');
});
