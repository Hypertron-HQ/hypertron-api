# Hypertron API — Render deploy

Use this when creating the **hypertron-api** Web Service on Render. It matches the working **hypertron-core-backend** Docker setup.

## 1. Create services

### Option A — Blueprint (repo already has `hypertron-api/render.yaml`)

1. Render Dashboard → **New** → **Blueprint**
2. Select the repo. If the Blueprint file is inside `hypertron-api`, set the root / blueprint path accordingly.
3. Fill every `sync: false` env var from section 3.

### Option B — Manual (same as core)

1. **New** → **Web Service**
2. Connect the GitHub repo
3. **Root Directory:** `hypertron-api`
4. **Runtime:** Docker
5. **Dockerfile path:** `./Dockerfile` (relative to the root directory)
6. **Health Check Path:** `/health`
7. **Instance:** Starter (or higher)

Do **not** set `PORT`. Render injects it; the app listens on `0.0.0.0:$PORT`.

**Redis is optional.** This deploy uses `DISABLE_REDIS=true` (in-memory rate limits; no webhook/reconciler queues). When you add Render Key Value later, set `DISABLE_REDIS=false`, `DISABLE_WORKERS=false`, `THROTTLE_STORAGE=redis`, and `REDIS_URL` to the Internal URL.

## 2. MongoDB

Use a **separate database name** `hypertron_api` on the same Atlas cluster as core (`hypertron`). Do not point this service at the core `hypertron` database.

Atlas Network Access must allow Render (or `0.0.0.0/0` if you already did that for core).

After the first successful boot, if collections are empty, from a machine with `DATABASE_URL` set:

```bash
cd hypertron-api
pnpm exec prisma generate
pnpm db:push:api
```

## 3. Environment variables (paste into Render)

Render → service → **Environment** → **Add from .env** (or paste key/value pairs).

Copy `hypertron-api/docs/ops/RENDER_ENV.example` and replace every `REPLACE_*` value.

**Must match live core-backend:**

| hypertron-api | hypertron-core-backend |
|---|---|
| `AUTH_SECRET` | `AUTH_SECRET` (same HMAC cookie secret) |
| `INTERNAL_SERVICE_TOKEN` | `INTERNAL_SERVICE_TOKEN` |
| `CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` | `SERVICE_ACCOUNT_API_KEY` |
| `CORE_BACKEND_URL` | `https://hypertron-core-backend.onrender.com` |
| `PAYMENT_POOL_ADDRESS` | same pool `C…` address as core (optional for classic G checkout) |

**Do not copy** core `DATABASE_URL` as-is — change the path to `/hypertron_api`.

## 4. After hypertron-api is live — update core

On **hypertron-core-backend** Render env, set:

```
PAYMENTS_API_URL=https://hypertron-api.onrender.com
INTERNAL_SERVICE_TOKEN=<same token as this API>
```

Then redeploy or restart core so merchant sync (`PUT /internal/merchant-settings`) works.

## 5. Smoke tests

```bash
BASE=https://hypertron-api.onrender.com

curl -sS "$BASE/"
curl -sS "$BASE/health"

# internal sync (must match INTERNAL_SERVICE_TOKEN)
curl -sS -X PUT "$BASE/internal/merchant-settings" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" \
  -d '{"businessId":"smoke_biz","walletAddress":"GSVCACCOUNTTESTNET00000000000000000000000000000000000000"}'

# no token → 401
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X PUT "$BASE/internal/merchant-settings" \
  -H "Content-Type: application/json" \
  -d '{"businessId":"x","walletAddress":"GSVCACCOUNTTESTNET00000000000000000000000000000000000000"}'
```

Expect: `GET /` → `{"service":"hypertron-api","status":"ok"}`; `GET /health` → `status: ok`, `coreBackend: configured`; internal PUT with token → `200`; without token → `401`.

First boot can take 1–2 minutes (cold Docker + Atlas).

## 6. Auth matrix (do not mix)

| Caller | Target | Credential |
|---|---|---|
| Browser dashboard | core-backend | `ht_dashboard` cookie |
| Merchant app | hypertron-api `/v1/*` | `Authorization: Bearer sk_test_…` |
| Core backend | hypertron-api `/internal/*` | `X-Internal-Token` |
| Hypertron-api | core-backend `/api/*` | `Authorization: Bearer ht_svc_…` |
