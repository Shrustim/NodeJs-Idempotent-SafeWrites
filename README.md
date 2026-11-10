# NODE-13 — Idempotent & Safe Writes (Node.js + PostgreSQL)

## Goal / benefits

Build an API that does **not** create duplicate orders when clients retry, does not oversell stock when requests overlap, and does not silently overwrite an order's note when two editors update the same record.

This task practices: `Idempotency-Key`, payload hashes, safe response replay, business dedupe keys, PostgreSQL `ON CONFLICT` (UPSERT), transaction-scoped advisory locks, optimistic version checks, HTTP `409`, `503` with `Retry-After`, and concurrent testing.

**Practice-only scope:** No frontend, auth service, payment gateway, queue, Docker, Redis, or Prisma. Because auth is out of scope, the example uses a fixed client ID (`demo-client`). Do **not** deploy this as a publicly writable API; a production API must derive the client/tenant ID from verified authentication and authorize access to products and orders.

## 1. What the concepts mean

| Concept | Meaning | This project |
| --- | --- | --- |
| Idempotency | Retrying the same operation must not apply its business effect again | Same `Idempotency-Key` returns stored status/body |
| Payload fingerprint | Hash of a normalized request | Reject reuse of the same key with different order details |
| Business dedupe | Unique logical business identifier | Unique `(client_id, external_order_id)` |
| UPSERT | Insert or update atomically according to a unique constraint | `PUT /products/:sku` |
| Transaction | All DB changes commit together or roll back together | Dedupe record + stock change + order insert |
| Advisory lock | An application-defined lock managed by PostgreSQL | Coordinate requests for the same external order |
| Optimistic locking | An update requires the expected row version | `PATCH /orders/:id/note` |
| `Retry-After` | Client should delay before a retry | Temporary `503` when advisory lock is busy |

### Why a button-disabled frontend is not enough

Two clients, network retries, concurrent workers, and lost HTTP responses are all independent of frontend button state. The database must enforce safety as well.

## 2. Prerequisites

- Node.js **20 or newer** (`node -v`).
- PostgreSQL 14 or newer, running locally.
- pgAdmin Query Tool for SQL, and Postman for HTTP testing (or use a terminal).
- Any code editor.

## 3. Project structure

```text
node13-safe-writes-practice/
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── sql/
│   └── schema.sql
├── src/
│   ├── db.js
│   └── server.js
└── test/
    └── integration.test.js
```

## 4. Install and create database

Open PowerShell in the project directory:

```powershell
npm install
node -v
```

In **pgAdmin**, open the Query Tool connected to your local PostgreSQL server and run:

```sql
CREATE DATABASE safe_writes_practice;
```

Connect the Query Tool to the **safe_writes_practice** database. Open `sql/schema.sql` and execute its complete contents. This creates the three tables and seeds two products:

- `COFFEE`: price 15000 minor units (₹150.00 if interpreted as paise), stock 10
- `TEA`: price 5000 minor units (₹50.00), stock 10

The `schema.sql` seed is safe to rerun; it does not reset previously used stock.

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace `YOUR_PASSWORD` with your **actual local PostgreSQL password**:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/safe_writes_practice
PORT=3000
```

If your password contains reserved URL characters (`@`, `#`, `:`, `/`, `%`), URL-encode them first. E.g. an `@` becomes `%40`. Never commit `.env` to Git.

Run the API:

```powershell
npm start
```

Expected startup line:

```text
Safe writes practice API running at http://localhost:3000
```

**Reminder:** A listening message alone does not guarantee PostgreSQL authentication works. Make a `GET /products/COFFEE` request to verify DB connectivity.

## 5. API #1 — Read product

**GET** `http://localhost:3000/products/COFFEE`

Expected result before any order:

```json
{ "sku": "COFFEE", "priceCents": 15000, "stock": 10 }
```

If you get HTTP 500, check the database password, DB existence, or execution of `schema.sql`.

## 6. API #2 — Place order safely with an idempotency key

**POST** `http://localhost:3000/orders`

In Postman choose **Body → raw → JSON**, and enter:

```json
{
  "externalOrderId": "ORD-101",
  "sku": "COFFEE",
  "quantity": 2
}
```

Set headers:

```text
Content-Type: application/json
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

**First request:** `201 Created`, with a generated `id`, `externalOrderId`, `quantity`, `priceCents`, `note`, `version:1`. COFFEE stock goes from 10 to 8.

**Exact same request + exact same key:** `201 Created` (replay of the original status/body) and response header `Idempotency-Replayed: true`. The order `id` remains the same; stock remains 8.

**Same key + quantity changed to 3:** `409 Conflict` with `Idempotency-Key reused with different request data`. No new order is created.

**New key + same externalOrderId and same details:** `200 OK` with the existing order. This tests the *business dedupe key* in addition to the header key.

**New key + same externalOrderId but different details:** `409 Conflict` because one logical order ID cannot represent two different orders.

**New externalOrderId + new key:** `201 Created` for a genuinely new order.

The code normalizes `sku` before hashing and hashes a fixed object of `{method,path,externalOrderId,sku,quantity}`. Reordering JSON object keys does not cause a false mismatch.

### Why the transaction matters

Inside a **single PostgreSQL transaction**, the app:

1. Inserts an idempotency record or waits for the matching unique record to commit.
2. If a completed matching key exists, loads its stored status/body and safely replays it.
3. If this is a new key, attempts a transaction-scoped advisory lock for the *logical external order ID*.
4. Checks the unique business order ID to avoid duplication across distinct request keys.
5. Atomically decrements stock, **only if enough stock is available**.
6. Inserts the order and stores the final status/body in the idempotency row.
7. Commits all changes together.

An unexpected error rolls back *both* the business operation and the idempotency record. A temporary advisory-lock failure also rolls back the idempotency record, so retrying the **same key** remains possible.

### Check your database

Run in Query Tool:

```sql
SELECT id, client_id, external_order_id, sku, quantity, version
FROM orders ORDER BY created_at DESC;

SELECT sku, price_cents, stock FROM products ORDER BY sku;

SELECT client_id, idempotency_key, request_hash,
       status_code, response_body, created_at
FROM idempotency_requests ORDER BY created_at DESC;
```

## 7. API #3 — UPSERT (insert or update without duplicate SKU)

**PUT** `http://localhost:3000/products/COFFEE`

Body:

```json
{ "priceCents": 16000 }
```

Run it once, then repeat it. Both return `200 OK`; the price is 16000 and there is still one COFFEE row. Existing stock is left unchanged.

The SQL uses:

```sql
INSERT INTO products (sku, price_cents, stock)
VALUES ($1, $2, 0)
ON CONFLICT (sku)
DO UPDATE SET price_cents = EXCLUDED.price_cents
RETURNING sku, price_cents, stock;
```

This sets an **absolute value**, making the same PUT safe to repeat. A retry of `stock = stock + 5` would **not** be idempotent unless also protected by a unique request key. UPSERT alone is not a universal idempotency mechanism.

## 8. API #4 — Optimistic locking and HTTP 409

First, get the ID from the successful order response.

**GET** `http://localhost:3000/orders/<ORDER_UUID>`

The order initially has `version: 1`.

**PATCH** `http://localhost:3000/orders/<ORDER_UUID>/note`

Body:

```json
{
  "note": "Prepare without sugar",
  "expectedVersion": 1
}
```

Expected first response: `200 OK`, `note` is updated, and `version` becomes `2`.

Send another update with `expectedVersion: 1`:

```json
{
  "note": "Make it extra hot",
  "expectedVersion": 1
}
```

Expected response: `409 Conflict` with `currentVersion: 2`. No data is overwritten.

Correct approach: `GET` the latest order, consider the changed note, and submit again with its current version (e.g. 2). Do **not** blindly retry stale version writes.

The critical SQL is:

```sql
UPDATE orders
SET note = $1, version = version + 1
WHERE id = $2 AND client_id = $3 AND version = $4
RETURNING id, note, version;
```

## 9. Advisory locks and Retry-After

The API attempts:

```sql
SELECT pg_try_advisory_xact_lock(
  hashtextextended('order:demo-client:ORD-101', 0)
);
```

This transaction-scoped advisory lock is automatically released on `COMMIT` or `ROLLBACK`.

When a different request is already working on **the same logical order ID**, a second new-key request can receive:

```text
HTTP/1.1 503 Service Unavailable
Retry-After: 1
```

Response:

```json
{ "error": "This order is being processed; retry with the same key" }
```

The app does **not** create a queued job: this is a retry path, not a queue implementation. The `Retry-After` value is a suggested delay, not a guarantee that the lock will be free by then. The client should use a limited retry count and (in real services) backoff/jitter.

**Important:** Different requests with the exact *same* idempotency key may instead wait for the original transaction to finish and then replay its result. An advisory lock is an additional coordination tool, not a substitute for unique database constraints.

To test lock contention deterministically without timing tricks, run the automated test in the next step; it opens a transaction holding the advisory lock while sending the POST.

## 10. Automated concurrency tests

Keep the API running in one PowerShell window. Open a second PowerShell window **in the project directory** and run:

```powershell
npm test
```

The integration test uses actual PostgreSQL and HTTP calls, with a unique test SKU so it does not consume the demo COFFEE stock.

Test coverage:

1. Twelve simultaneous requests with **one** Idempotency-Key: one order, one stock deduction, same order ID in every response.
2. Reuse that key with a changed quantity: `409`.
3. Eight concurrent requests with **different** keys but one `externalOrderId`: one business order and one stock deduction (temporary `503` responses are retried with the same keys).
4. Repeat the same product-price UPSERT twice: no stock change.
5. Two concurrent note changes using the same expected version: exactly one succeeds, one receives `409`.
6. Hold a real PostgreSQL advisory lock from a separate connection: receive `503` + `Retry-After: 1`, release lock, retry **same** key successfully.
7. Repeat an out-of-stock order with one key: same stored `409` response is replayed.

You need the API and PostgreSQL running or integration tests cannot pass. **This project has not been integration-tested against a live PostgreSQL instance in the artifact generation environment.** The JavaScript syntax was checked with Node 22.

## 11. HTTP status and replay behavior

| Scenario | Status | Retry advice |
| --- | --- | --- |
| First valid order | `201` | No retry needed |
| Same key and same request | Original stored status (usually `201`) | Replay; no new write |
| Same key, different request | `409` | Fix request/use new key only for a different intended operation |
| New key, same business order and same details | `200` | Existing order returned |
| New key, same business ID but different details | `409` | Resolve business conflict |
| Insufficient stock | `409` | Change request/resolve stock; replaying same key gives stored conflict |
| Missing product | `404` | Fix SKU |
| Old `expectedVersion` | `409` | Read latest version; resolve conflict |
| Busy advisory lock | `503` + `Retry-After: 1` | Retry **same** key after suggested delay |
| Unanticipated DB error | `500` | Transaction rolls back; investigate; a retry with the same key can be safe |

**Standards note:** The emerging IETF `Idempotency-Key` draft recommends `422` for a reused key with a different payload. This practice deliberately returns `409` because the task explicitly requests conflict handling; production clients should follow their API's documented status contract.

## 12. Common mistakes to avoid

1. **Checking then inserting without a database unique constraint** — two requests can both see “not found.” Keep the `PRIMARY KEY` on idempotency records and the unique `(client_id, external_order_id)` business key.
2. **Storing the key in memory** — fails across restarts and multiple Node processes. Store in PostgreSQL.
3. **Recording the idempotency row in a separate committed transaction** — a crash can leave an unrecoverable processing row, or a business effect without its replay record. Commit response + business write together when feasible.
4. **Reusing the same key for different requests** — reject mismatched request fingerprints.
5. **Generating a fresh key on every retry** — repeat the *same* key for the same intended operation.
6. **Using `pool.query` for statements inside a transaction** — use one checked-out client until COMMIT/ROLLBACK.
7. **Assuming UPSERT protects counters from retries** — `SET stock = stock + 5` repeats the increment; use dedupe for additive events.
8. **Using advisory locks without unique constraints** — locks are cooperative, and 64-bit hashes can theoretically collide; constraints enforce integrity.
9. **Using session advisory locks without releasing them** — prefer `pg_try_advisory_xact_lock` for short transactions.
10. **Reading the version then updating without `WHERE version = ...`** — allows lost updates. Check and increment version in one SQL statement.
11. **Retrying every `409` blindly** — payload mismatch or stale version usually requires a correction, not an identical retry.
12. **Permanently caching a temporary `503`** — this project rolls back the idempotency row on lock contention so the same key can later succeed.
13. **Ignoring stock concurrency** — use the atomic conditional decrement with `stock >= quantity`, not read-then-write arithmetic in Node.
14. **Using the provided fixed client ID in production** — derive scopes from authenticated identity, not user-controlled headers.
15. **Deleting dedupe records too early** — define a published key retention period; database business uniqueness should still protect old logical orders.

## 13. Completion checklist

- [ ] Database and tables created, `.env` configured, API running.
- [ ] First order created as `201` and stock decremented once.
- [ ] Same key replayed with matching order ID and response.
- [ ] Reused key with changed payload rejected.
- [ ] Different key with same external business ID deduplicated.
- [ ] UPSERT repeated without adding a second product or changing stock.
- [ ] Version conflict returns `409` and prevents overwriting the note.
- [ ] Lock contention returns `503` and `Retry-After`.
- [ ] All concurrency integration tests pass on your machine.
- [ ] You can explain why DB constraints + transactions are necessary.

## 14. Important boundaries for real production use

This is intentionally a practice project. For production, also implement verified authentication, tenant scoping, authorization, per-endpoint idempotency retention policy and cleanup, rate limiting, observability, consistent `Idempotency-Key` header syntax, bounded lock/statement timeouts, retries with jitter and safety checks, and a well-defined response contract. If you call an **external payment/email service**, the local DB transaction cannot roll back that external effect; use the provider's idempotency mechanism and/or transactional outbox rather than assuming a local transaction alone gives exactly-once delivery.

For an idempotency-key retention policy, e.g. `24 hours`, a housekeeping job *might* run `DELETE FROM idempotency_requests WHERE created_at < NOW() - INTERVAL '24 hours'`, but only after your API explicitly documents that window. Once expired, the original `201` replay guarantee ends; the separate business dedupe key still protects the logical order.

### Documentation consulted

- PostgreSQL UPSERT: https://www.postgresql.org/docs/current/sql-insert.html
- PostgreSQL advisory locks: https://www.postgresql.org/docs/current/functions-admin.html
- node-postgres transactions: https://node-postgres.com/features/transactions
- HTTP `Retry-After`: https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
- Idempotency-Key draft: https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header
