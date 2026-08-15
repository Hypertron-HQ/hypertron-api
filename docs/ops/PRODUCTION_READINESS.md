# Production readiness — Phase 10

Operational runbook for HyperTone Payments API (`hypertron-api`).

## Security review checklist

| Check | Status | Evidence |
| --- | --- | --- |
| Authorization / cookies / signing secrets redacted from logs | Pass | `src/app.module.ts` Pino `redact.paths` + `test/unit/security-hygiene.spec.ts` |
| API key raw secret returned once only | Pass | `ApiKeyService.generate` / rotate; developer integration tests |
| Webhook signing secret returned once; encrypted at rest | Pass | `WebhookSigner` AES-GCM envelope; webhook integration tests |
| Cross-merchant isolation on payments / customers / webhooks | Pass | Integration + e2e (`merchant B` → 404) |
| Test vs live environment isolation | Pass | Payments integration (test key cannot read live) |
| No private Stellar keys in repo | Pass | Destination addresses only; hygiene unit test |
| Rate-limit errors do not leak internal keys | Pass | `ThrottlerExceptionFilter` + Hypertron error envelope |

Re-run review after any auth, logging, or webhook crypto change.

## Alerts & dashboards (Plan §20.7)

Scrape Prometheus metrics from `GET /metrics` (or OTLP when enabled).

Recommended alert rules:

| Alert | Condition | Window |
| --- | --- | --- |
| High API error rate | `sum(rate(api_requests_total{status=~"5.."}[5m])) / sum(rate(api_requests_total[5m])) > 0.01` | 5m |
| Reconciliation errors | `increase(reconciliation_errors_total[5m]) > 0` | 5m |
| Webhook permanent failures | `increase(webhook_deliveries_total{status="failed"}[1h]) > 0` | 1h |
| Slow API | histogram P99 of `api_request_duration_seconds` > 2 | 5m |
| Redis / Mongo | platform connection / pool saturation alerts from host provider |

Dashboard panels: request rate by route, payment created/completed/failed counters, webhook delivery outcomes, reconciler errors, rate-limit hits.

## Staging / production deploy (Render)

See `docs/ops/RENDER_DEPLOY.md` and `docs/ops/RENDER_ENV.example`.

1. Web Service: Root Directory `hypertron-api`, runtime **Docker**, health `/health`. Do not set `PORT`.
2. Key Value Redis (`noeviction`) → `REDIS_URL`.
3. Fill secrets: `DATABASE_URL` (`hypertron_api` DB), `AUTH_SECRET` (same as core), `INTERNAL_SERVICE_TOKEN` (same as core), `CORE_BACKEND_URL`, `CORE_BACKEND_SERVICE_ACCOUNT_API_KEY` (same as core `SERVICE_ACCOUNT_API_KEY`), `WEBHOOK_SECRET_ENCRYPTION_KEY`, `APP_URL`, `CHECKOUT_BASE_URL`, `CORS_ORIGINS`.
4. First deploy: `pnpm db:push:api` against Atlas if collections are empty.
5. Smoke: `curl -sS "$URL/health"` — expect `coreBackend: configured`.
6. On **core** Render: set `PAYMENTS_API_URL` to this service’s HTTPS origin.

## Local Docker

```bash
docker compose up --build
# health: http://localhost:3000/health
```

E2E (spins `docker-compose.e2e.yml` automatically):

```bash
pnpm test:e2e
```

Load probe against a running API:

```bash
API_KEY=sk_test_... pnpm load:rate-limit
```
