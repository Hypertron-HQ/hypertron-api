# Hypertron API — Render API test report

**Target:** https://hypertron-api.onrender.com  
**Core:** https://hypertron-core-backend.onrender.com  
**Retested:** 2026-08-15T20:15Z (UTC)
**This run:** full flow (identity → internal sync → mint `sk_test_` → payments / customers / webhooks)

> **Deployment status:** the fixes are live on Render. All 39 checks passed.
> MongoDB is up, the core backend integration is configured, and Redis is
> intentionally disabled.

### Local fix verification

| Check | Result |
|---|---|
| Production TypeScript build | PASS |
| Complete Jest suite | **430 passed**, 2 skipped |
| Docker-backed E2E | **10 passed / 10** |
| Expanded API-key control-plane E2E | PASS (list, second same-env key, rotate, revoke) |
| Expanded webhook E2E | PASS (create, list, patch, rotate, test, deliveries, delete) |
| Payments E2E | PASS (multiple creates, get, events, cancel, pagination) |
| Render Docker image build | PASS (`hypertron-api:render-fix`) |

The redeployed service will repair the existing Atlas indexes during startup:

1. remove `api_keys_businessId_environment_keyPrefix_key`;
2. replace `payments_transactionHash_key` with a partial unique index that
   indexes only string transaction hashes.

Server logs now include request ID, HTTP method/path, exception name/message,
and stack trace for unhandled 500s. Client responses remain sanitized.

**Auth used**
- Core: `Authorization: Bearer $CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` (`ht_svc_…`)
- API internal: `X-Internal-Token: $INTERNAL_SERVICE_TOKEN`
- Dashboard: HMAC `ht_dashboard` cookie (`AUTH_SECRET`, wallet = core service account `GSVC…`)
- Merchant API: temporary `sk_test_` created, rotated, and revoked during this run

---

## Score (this run)

| | Count |
|---|---|
| **Passed** | **39** |
| **Failed** | **0** |
| Total curls | 39 |

Core-backend: **5 / 5 PASS**. Hypertron API: **34 / 34 PASS**.

`GET /health` this run: **200** (`database: up`, `coreBackend: configured`, `redis: disabled`).

---

## Result table

### Core — https://hypertron-core-backend.onrender.com

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 1 | `GET /` | 200 | 200 | PASS |
| 2 | `GET /health` | 200 | 200 | PASS |
| 3 | `GET /api/auth/me` no auth | 401 | 401 | PASS |
| 4 | `GET /api/auth/me` service key | 200 | 200 | PASS (`auth: service`) |
| 5 | `GET /api/business/profile` | 200 | 200 | PASS (`cmsuoj7ws0001uune7slmpnts`) |

### API identity / CORS / internal

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 6 | `GET /` | 200 | 200 | PASS |
| 7 | `GET /health` | 200 | 200 | PASS |
| 8 | OPTIONS CORS `http://localhost:3000` | 204 | 204 | PASS |
| 9 | `GET /does-not-exist` | 404 | 404 | PASS |
| 10 | `GET /metrics` | 200 | 200 | PASS |
| 11 | `PUT /internal/merchant-settings` no token | 401 | 401 | PASS |
| 12 | `PUT /internal/merchant-settings` ok | 200 | 200 | PASS |

### Developer API keys (cookie)

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 13 | `GET /api/developer/api-keys` no cookie | 401 | 401 | PASS |
| 14 | `GET /api/developer/api-keys` session | 200 | 200 | PASS |
| 15 | `POST /api/developer/api-keys` create **test** | 201 | 201 | PASS |
| 16 | `POST …/rotate` | 200 | 200 | PASS |
| 17 | `POST …/revoke` | 200 | 200 | PASS |

A second test key was created successfully, confirming the obsolete
`(businessId, environment, keyPrefix)` unique index was removed.

### Payments / checkout (`sk_test_`)

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 18 | `POST /v1/payments` missing Idempotency-Key | 400 | 400 | PASS |
| 19 | `POST /v1/payments` bad key | 401 | 401 | PASS |
| 20 | `POST /v1/payments` create | 201 | 201 | PASS |
| 21 | `POST /v1/payments` replay | 201 | 201 | PASS (same payment ID) |
| 22 | `GET /v1/payments` list | 200 | 200 | PASS |
| 23 | `GET /v1/payments` unknown | 404 | 404 | PASS |
| 24 | `GET /v1/payments/:id` | 200 | 200 | PASS |
| 25 | `GET /v1/payments/:id/events` | 200 | 200 | PASS |
| 26 | `GET /v1/checkout-links` unknown | 404 | 404 | PASS |
| 27 | `GET /v1/checkout-links/:id` | 200 | 200 | PASS |
| 28 | `POST /v1/payments/:id/cancel` | 200 | 200 | PASS |

Payment creation succeeded; the idempotent replay returned the same payment ID.
A separate payment was created and canceled.

### Customers

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 29 | `GET /v1/customers` | 200 | 200 | PASS (`n=8`) |
| 30 | `GET /v1/customers/:id` | 200 | 200 | PASS |
| 31 | `GET /v1/customers` unknown | 404 | 404 | PASS |
| 32 | `GET /api/developer/customers` | 200 | 200 | PASS |

### Webhooks

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 33 | `POST /api/developer/webhook-endpoints` | 201 | 201 | PASS |
| 34 | `GET` list | 200 | 200 | PASS |
| 35 | `PATCH :id` | 200 | 200 | PASS |
| 36 | `POST :id/rotate-secret` | 200 | 200 | PASS |
| 37 | `POST :id/test` | 200 | 200 | PASS |
| 38 | `GET :id/deliveries` | 200 | 200 | PASS |
| 39 | `DELETE :id` | 200 | 200 | PASS |

---

## Previously observed errors — resolved

### 1. Dashboard list / mutate — previously HTTP 500

```json
{"error":{"type":"api_error","code":"api_error","message":"An unexpected error occurred. Please try again later.","request_id":"req_01M03FDSQ5TV8JP8ZBVJGQAMSG"}}
```

This is retained as historical evidence from the pre-fix deployment. All
API-key and webhook list/mutation requests now return their expected 2xx status.

**Resolved cause:** the Prisma `environment-scope` extension previously rejected
cross-environment dashboard queries and globally unique public-ID lookups.

Affected queries:
- `apiKey.findMany({ where: { businessId: { in: […] } } })`
- `apiKey.findFirst({ where: { publicId, businessId } })` (rotate/revoke)
- `webhookEndpoint.findMany({ where: { businessId } })`
- `webhookEndpoint.findFirst({ where: { publicId, businessId } })`
- `payment.findFirst({ where: { publicId, businessId } })` (events — 500 in the prior run)

### 2. Create payment — previously HTTP 409

```json
{"error":{"type":"idempotency_error","code":"conflict","message":"A conflicting resource already exists.","request_id":"req_01M03FE1V6B28N8NBPDD1ZMQHX"}}
```

**Resolved cause:** MongoDB's old unique index treated `null` transaction hashes
as duplicates. Startup repair replaced it with a partial unique index that only
indexes string hashes. Multiple pending payments and same-environment API keys
now work.

### 3. Follow-on 404s — resolved

Payment details, events, public checkout, and cancellation all passed once
payment creation succeeded.

---

## Live result summary

```
CORE GET /                 200  hypertron-core-backend ok
CORE GET /health           200  database: ok
CORE GET /api/auth/me      200  auth: service
API  GET /                 200  hypertron-api ok
API  GET /health           200  database:up  coreBackend:configured  redis:disabled
API  PUT /internal/merchant-settings  200  businessId cmsuoj7ws0001uune7slmpnts
API  POST /api/developer/api-keys     201  sk_test_
API  POST /v1/payments                201  pending
API  POST /v1/payments replay         201  same payment ID
API  GET  payment/events/checkout     200
API  POST payment cancel              200  canceled
API  GET  /v1/customers               200
API  webhook lifecycle                2xx  create/list/update/rotate/test/delete
API  API-key lifecycle                2xx  create/list/rotate/revoke
```

---

## Env vs behaviour

| Flag | Live effect |
|---|---|
| `DISABLE_REDIS=true` | `/health` → `redis: disabled`; webhook *delivery* not queued |
| `CHECKOUT_BASE_URL=http://localhost:3000` | checkout URLs stay localhost when create succeeds |
| `CORE_BACKEND_URL` | Configured; core service key works |
| `CORS_ORIGINS=http://localhost:3000` | ACAO set on OPTIONS |

---

## Deployed fixes verified

1. Environment-scope now permits business-scoped globally unique `publicId`
   lookups and explicit dashboard scope across `test` + `live`.
2. `Payment.transactionHash` is repaired to a partial unique MongoDB index, so
   multiple unpaid payments can coexist while real transaction hashes remain
   unique.
3. The API-key prefix uniqueness restriction is removed, allowing multiple
   `sk_test_` and `sk_live_` keys per business.
4. Render-visible server logging now records the real exception and stack trace.
5. E2E regressions cover every previously failing dashboard/payment/webhook
   path.

The post-deploy curl run verified all five fixes with **39 passed / 0 failed**.
