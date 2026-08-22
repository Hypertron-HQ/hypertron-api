# Hypertron Payments API (`hypertron-api`)

Merchant-facing **stablecoin payment gateway** for Hypertron. It issues secret API keys, creates `Payment` objects with hosted checkout URLs, reconciles Stellar transactions, and delivers signed webhooks.

This service does **not** own dashboard login, workspaces, or Collect payment links. Those live in `hypertron-core-backend`. This API stores its own data in the dedicated MongoDB database `hypertron_api`.

| | |
| --- | --- |
| Default local port | **4001** (`PORT` in `.env.example`) |
| Database | MongoDB — database name **`hypertron_api`** |
| Package manager | **pnpm** (Node 20) |
| Framework | NestJS 11 + Prisma (MongoDB) |

If `PORT` is unset, the process falls back to `3000`. Copy `.env.example` so local ports stay aligned with the rest of the stack.

---

## Role in the stack

```
Merchant backend          Dashboard (Freighter)           Hosted checkout
      |                          |                              |
      | Bearer sk_test_/sk_live_ | ht_dashboard cookie          | public GET
      v                          v                              v
 /v1/payments              /api/developer/*           /v1/checkout-links/:id
      |                          |
      +-------- this service ----+
                    |
                    | service account (X-Service-Key)
                    v
          hypertron-core-backend
                    |
                    | PUT /internal/merchant-settings
                    v
               this service (MerchantSettings)
```

**Data isolation**

| Database | Owner | Do not mix |
| --- | --- | --- |
| `hypertron_api` | this repo | Business, PaymentLink, AuthChallenge |
| `hypertron` | core-backend | api_keys, payments, webhooks |
| `hypertron_indexer` | indexer | privacy-pool leaves |

Never run `prisma db push` against the core `hypertron` database from this repo. `pnpm db:push` is blocked on purpose; use `pnpm db:push:api`.

---

## Prerequisites

- Node.js **20.x**
- [pnpm](https://pnpm.io/) 10.x (`packageManager` is pinned in `package.json`)
- MongoDB connection string whose path is **`/hypertron_api`**
- Redis is **optional**. Local default is `DISABLE_REDIS=true` (in-memory rate limits, no BullMQ workers)
- Running `hypertron-core-backend` if you need merchant resolution, service-account business IDs, or dashboard cookies

---

## Quick start

```bash
cp .env.example .env
# Fill DATABASE_URL (.../hypertron_api), AUTH_SECRET, CORE_BACKEND_* as needed

pnpm install
pnpm exec prisma generate
pnpm db:push:api
pnpm start:dev
```

Health:

```bash
curl -sS http://localhost:4001/health
curl -sS http://localhost:4001/
# { "service": "hypertron-api", "status": "ok" }
```

OpenAPI / Swagger is at **http://localhost:4001/docs** when `SWAGGER_ENABLED=true` or `NODE_ENV` is not `production`.

---

## Environment

Template: [`.env.example`](.env.example). Render paste file: [`docs/ops/RENDER_ENV.example`](docs/ops/RENDER_ENV.example).

### Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | MongoDB URI for **`hypertron_api` only** |
| `AUTH_SECRET` | HMAC for `ht_dashboard` cookies. **Must match core** |
| `INTERNAL_SERVICE_TOKEN` | Shared secret for `PUT /internal/merchant-settings`. **Must match core** |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | 64 hex chars (32-byte AES-256-GCM key). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Production also requires `CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` (same value as core `SERVICE_ACCOUNT_API_KEY`).

### Application

| Variable | Default / notes |
| --- | --- |
| `PORT` | `4001` in the example file |
| `APP_URL` | Public origin of this API |
| `CHECKOUT_BASE_URL` | Frontend origin used to build `checkout_url` (`{CHECKOUT_BASE_URL}/pay/cl_...`) |
| `CORS_ORIGINS` | Comma-separated origins, no trailing slashes |
| `SWAGGER_ENABLED` | `true` locally; keep `false` in production |

### Core backend

| Variable | Notes |
| --- | --- |
| `CORE_BACKEND_URL` | Default live URL is `https://hypertron-core-backend.onrender.com` |
| `CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` | Same as core `SERVICE_ACCOUNT_API_KEY` |
| `CORE_BACKEND_TIMEOUT_MS` | Default `8000` |

On **core**, after this API is live, set `PAYMENTS_API_URL` to this service's origin so merchant settings sync.

### Redis / workers

| Variable | Local default | Meaning |
| --- | --- | --- |
| `DISABLE_REDIS` | `true` | Skip Redis; in-memory throttling |
| `DISABLE_WORKERS` | `true` | No BullMQ reconciler / webhook processors |
| `THROTTLE_STORAGE` | `memory` | Use `redis` when Redis is on |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Required when Redis is enabled |

Webhook retries and Horizon polling **need Redis + workers**. With workers disabled, payments stay `created` until you enable them (or rely on other flows).

### Stellar

Public Horizon URLs and USDC/EURC issuers are in `.env.example`. `PAYMENT_POOL_ADDRESS` is the privacy-pool `C...` contract — **not** a classic checkout destination. Classic fallbacks are `STELLAR_*_DESTINATION_ADDRESS` when a business has no `receiveAddress`.

---

## Authentication

Two HTTP planes, plus one internal plane.

| Plane | Auth | Prefix |
| --- | --- | --- |
| Public Payments API | `Authorization: Bearer sk_test_...` or `sk_live_...` | `/v1/*` |
| Dashboard control-plane | Freighter cookie `ht_dashboard` (HMAC `AUTH_SECRET`, shared with core) | `/api/developer/*` |
| Internal (core to API) | `X-Internal-Token` | `/internal/*` |
| Health / identity | none | `/`, `/health`, `/metrics`, `/docs` |

Rules:

- Test keys (`sk_test_`) only see **test** payments; live keys only see **live**.
- Raw `secret_key` is returned **once** on create/rotate. Only a bcrypt hash is stored.
- `Idempotency-Key` is required on `POST /v1/payments` (1-255 chars, retained at least 24 hours).
- Dashboard mutating routes (create/rotate/revoke keys, webhook writes) require Owner or Admin.

---

## HTTP API

### Public merchant API (`Authorization: Bearer sk_...`)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/payments` | Create payment + hosted checkout. Requires `Idempotency-Key` |
| `GET` | `/v1/payments` | Cursor-paginated list |
| `GET` | `/v1/payments/:id` | `pay_...` |
| `POST` | `/v1/payments/:id/cancel` | From `created` or `pending` |
| `GET` | `/v1/payments/:id/events` | Lifecycle events |
| `GET` | `/v1/customers` | Cursor-paginated |
| `GET` | `/v1/customers/:id` | `cus_...` |

Create-payment body:

```json
{
  "amount": "10.50",
  "currency": "USDC",
  "description": "Order #1234",
  "customer_email": "alice@example.com",
  "customer_name": "Alice Smith",
  "metadata": { "order_id": "ord_123" }
}
```

`amount` is a decimal **string**. Currencies: `USDC`, `EURC`, `XLM`.

### Public checkout (no API key)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/checkout-links/:publicId` | Hosted page `/pay/cl_...`. Shape matches core Collect GET so the frontend can branch on `expired`. |

### Dashboard (`ht_dashboard` cookie)

| Method | Path |
| --- | --- |
| `GET` `POST` | `/api/developer/api-keys` |
| `POST` | `/api/developer/api-keys/:id/rotate` |
| `POST` | `/api/developer/api-keys/:id/revoke` |
| `GET` | `/api/developer/customers` |
| `GET` | `/api/developer/customers/:id` |
| `GET` `POST` | `/api/developer/webhook-endpoints` |
| `PATCH` `DELETE` | `/api/developer/webhook-endpoints/:id` |
| `POST` | `/api/developer/webhook-endpoints/:id/rotate-secret` |
| `GET` | `/api/developer/webhook-endpoints/:id/deliveries` |
| `POST` | `/api/developer/webhook-endpoints/:id/deliveries/:deliveryId/retry` |
| `POST` | `/api/developer/webhook-endpoints/:id/test` |

### Internal

| Method | Path | Auth |
| --- | --- | --- |
| `PUT` | `/internal/merchant-settings` | `X-Internal-Token` |

Body: `{ "businessId", "walletAddress", "receiveAddress?" }`. Called by core when a workspace or business receive address changes. Failures on core are non-blocking; this API then uses env destination fallbacks.

### Ops

| Path | Notes |
| --- | --- |
| `GET /` | `{ service, status }` |
| `GET /health` | Process + Prisma ping. Also reports `coreBackend` and `redis`. |
| `GET /metrics` | Prometheus |
| `GET /docs` | Swagger UI (when enabled) |

Contract details: [`Payments_API_v1_Schema.md`](Payments_API_v1_Schema.md). Generated OpenAPI: [`openapi.yaml`](openapi.yaml) (`pnpm openapi:generate`).

---

## Payment lifecycle

```
created -> pending -> confirmed -> completed
   |          |            |
   +- canceled      failed / expired
                  confirmed -> failed
```

Stellar Horizon is the source of truth for completion (when workers are enabled). The reconciler polls open payments every **30s**; expiry runs every **60s**.

---

## Webhooks

Merchants register endpoints in the dashboard. Signing secrets are AES-256-GCM encrypted at rest and shown **once**.

Events: `payment.created`, `payment.pending`, `payment.confirmed`, `payment.completed`, `payment.failed`, `payment.expired`, `payment.canceled`.

Delivery headers include `Hypertron-Signature`, `Hypertron-Event-Id`, `Hypertron-Delivery-Id`. Up to **7** attempts (immediate, then 30s / 2m / 10m / 1h / 6h / 24h). Requires Redis + workers.

---

## Rate limits

| Bucket | Default / minute | Typical routes |
| --- | --- | --- |
| `payment-create` | 60 | `POST /v1/payments` |
| `read` | 300 | GET payments/customers |
| `dashboard` | 120 | `/api/developer/*` |

Override with `RATE_LIMIT_*_PER_MIN`. Responses expose `X-RateLimit-*` and `Retry-After`.

---

## Scripts

| Script | Action |
| --- | --- |
| `pnpm start:dev` | Watch mode |
| `pnpm build` | Nest build |
| `pnpm start:prod` | `node dist/main` |
| `pnpm db:push:api` | Prisma db push against **this** database |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | E2E (uses `docker-compose.e2e.yml`) |
| `pnpm lint` | ESLint |
| `pnpm openapi:generate` | Refresh `openapi.yaml` |
| `pnpm postman:generate` | Refresh Postman collection |
| `pnpm docker:up` | `docker compose up --build -d` |
| `pnpm load:rate-limit` | Rate-limit probe (`API_KEY=sk_test_...`) |

---

## Local Docker

```bash
pnpm docker:up
# health: http://localhost:3000/health
```

[`docker-compose.yml`](docker-compose.yml) runs API + MongoDB 7 + Redis 7 and maps the API to **host port 3000** (container `PORT=3000`). That is separate from the `.env.example` local port **4001**.

---

## Deploy (Render)

See [`docs/ops/RENDER_DEPLOY.md`](docs/ops/RENDER_DEPLOY.md) and [`docs/ops/PRODUCTION_READINESS.md`](docs/ops/PRODUCTION_READINESS.md).

- Runtime: **Docker** (`Dockerfile`), health check `/health`
- Do **not** set `PORT` — Render injects it
- Atlas database name **`hypertron_api`**
- Match core: `AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN`, `CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` (same as core `SERVICE_ACCOUNT_API_KEY`)
- Then on core set `PAYMENTS_API_URL` to this service's HTTPS origin

Postman against a live deploy: [`postman/README.md`](postman/README.md).

---

## Related docs

- [`Payments_API_v1_Schema.md`](Payments_API_v1_Schema.md) — public API contract
- [`Plan.md`](Plan.md) — architecture blueprint
- [`docs/ops/RENDER_DEPLOY.md`](docs/ops/RENDER_DEPLOY.md)
- [`docs/ops/PRODUCTION_READINESS.md`](docs/ops/PRODUCTION_READINESS.md)
- Core to API plan: `hypertron-core-backend/INTEGRATION_PLAN.md` (sibling repo)
