# Hypertron API — Render API test report

**Target:** https://hypertron-api.onrender.com  
**Core:** https://hypertron-core-backend.onrender.com  
**Retested:** 2026-08-15T19:47:20Z (UTC)  
**This run:** full flow (identity → internal sync → mint `sk_live_` → payments / customers / webhooks)

> **Deployment status (2026-08-15T19:59Z UTC):** fixes are implemented
> and verified locally, but are **not on the deployed URL until this branch is
> pushed and Render redeploys it**. The live score below describes the current
> pre-fix Render deployment.

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
- Merchant API: `sk_live_` created this run (`key_01M03FDVJZYXY396979ZK8NR3F`)

---

## Score (this run)

| | Count |
|---|---|
| **Passed** | **24** |
| **Failed** | **15** |
| Total curls | 39 |

Core-backend: **5 / 5 PASS**.

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
| 14 | `GET /api/developer/api-keys` session | **500** | 200 | **FAIL** |
| 15 | `POST /api/developer/api-keys` create **live** | 201 | 201 | PASS `key_01M03FDVJZYXY396979ZK8NR3F` |
| 16 | `POST …/rotate` | **500** | 201 | **FAIL** |
| 17 | `POST …/revoke` | **500** | 200 | **FAIL** |

A second **test** key is blocked by schema unique `(businessId, environment, keyPrefix)` — only one `sk_test_` and one `sk_live_` per business. First test key already exists from the previous run; this run minted **live**.

### Payments / checkout (`sk_live_`)

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 18 | `POST /v1/payments` missing Idempotency-Key | 400 | 400 | PASS |
| 19 | `POST /v1/payments` bad key | 401 | 401 | PASS |
| 20 | `POST /v1/payments` create | **409** | 201 | **FAIL** |
| 21 | `POST /v1/payments` replay | **409** | 201 | **FAIL** (create never succeeded) |
| 22 | `GET /v1/payments` list | 200 | 200 | PASS (`n=0` — no live payments) |
| 23 | `GET /v1/payments` unknown | 404 | 404 | PASS |
| 24 | `GET /v1/payments/:id` | **404** | 200 | **FAIL** (no id — create 409) |
| 25 | `GET /v1/payments/:id/events` | **404** | 200 | **FAIL** |
| 26 | `GET /v1/checkout-links` unknown | 404 | 404 | PASS |
| 27 | `GET /v1/checkout-links/:id` | **404** | 200 | **FAIL** |
| 28 | `POST /v1/payments` cancel setup | **409** | 201 | **FAIL** |

Earlier run (test key) **did** create `pay_01M03ECJTY0XVX34QX9A178R2R`. Further creates now 409 for both test and live.

### Customers

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 29 | `GET /v1/customers` | 200 | 200 | PASS (`n=4`) |
| 30 | `GET /v1/customers/:id` | 200 | 200 | PASS `cus_01M03FEM4S3KTHTGXHM8E1XEZ7` |
| 31 | `GET /v1/customers` unknown | 404 | 404 | PASS |
| 32 | `GET /api/developer/customers` | 200 | 200 | PASS |

### Webhooks

| # | Request | Got | Want | Status |
|---|---|---|---|---|
| 33 | `POST /api/developer/webhook-endpoints` | 201 | 201 | PASS `we_01M03FEYRQ8NPYT9K1VWADAN8H` |
| 34 | `GET` list | **500** | 200 | **FAIL** |
| 35 | `PATCH :id` | **500** | 200 | **FAIL** |
| 36 | `POST :id/rotate-secret` | **500** | 200 | **FAIL** |
| 37 | `POST :id/test` | **500** | 200 | **FAIL** |
| 38 | `GET :id/deliveries` | **500** | 200 | **FAIL** |
| 39 | `DELETE :id` | **500** | 200 | **FAIL** |

---

## Errors (verbatim live bodies)

### 1. Dashboard list / mutate — HTTP 500

```json
{"error":{"type":"api_error","code":"api_error","message":"An unexpected error occurred. Please try again later.","request_id":"req_01M03FDSQ5TV8JP8ZBVJGQAMSG"}}
```

Same shape for: api-keys GET/rotate/revoke; webhook list/patch/rotate-secret/test/deliveries/delete.

**Cause (code):** Prisma `environment-scope` extension throws `MissingEnvironmentError` when `where` has `businessId` but no `environment: 'test'|'live'`. Dashboard list is cross-env by design. Unique `publicId` lookups also omit `environment`. Production filter maps that to a generic 500 (no stack in the JSON).

Affected queries:
- `apiKey.findMany({ where: { businessId: { in: […] } } })`
- `apiKey.findFirst({ where: { publicId, businessId } })` (rotate/revoke)
- `webhookEndpoint.findMany({ where: { businessId } })`
- `webhookEndpoint.findFirst({ where: { publicId, businessId } })`
- `payment.findFirst({ where: { publicId, businessId } })` (events — 500 in the prior run)

### 2. Create payment — HTTP 409

```json
{"error":{"type":"idempotency_error","code":"conflict","message":"A conflicting resource already exists.","request_id":"req_01M03FE1V6B28N8NBPDD1ZMQHX"}}
```

**Cause (code):** Prisma `P2002` unique violation mapped to `idempotency_error`. Schema has `transactionHash String? @unique`. Mongo unique indexes treat `null` as a value, so **only one payment with a null tx hash can exist**. After the first successful payment, every later `POST /v1/payments` 409s. Same for a second test API key: `@@unique([businessId, environment, keyPrefix])` allows only one `sk_test_` and one `sk_live_` per business.

### 3. Follow-on 404s

`GET payment`, `GET events`, `GET checkout`, cancel — failed because create never returned an id (`No such payment: 'undefined'` / `Checkout link not found`).

---

## What works on live

```
CORE GET /                 200  hypertron-core-backend ok
CORE GET /health           200  database: ok
CORE GET /api/auth/me      200  auth: service
API  GET /                 200  hypertron-api ok
API  GET /health           200  database:up  coreBackend:configured  redis:disabled
API  PUT /internal/merchant-settings  200  businessId cmsuoj7ws0001uune7slmpnts
API  POST /api/developer/api-keys     201  key_01M03FDVJZYXY396979ZK8NR3F  sk_live_
API  GET  /v1/customers               200
API  POST webhook-endpoints           201  we_01M03FEYRQ8NPYT9K1VWADAN8H
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

## Fixes implemented locally (awaiting Render redeploy)

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

After push + successful Render deployment, rerun the live curl suite and replace
the 24/15 pre-fix score above with the post-deploy result.
