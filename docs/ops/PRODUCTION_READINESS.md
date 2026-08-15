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

## Staging deploy (Render)

1. Connect the GitHub repo; apply `render.yaml` (service `hypertron-api-staging`).
2. Fill synced secrets: `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, destination addresses, `APP_URL`, `CHECKOUT_BASE_URL`, `CORS_ORIGINS`.
3. After first deploy: `pnpm exec prisma db push` (or migrate) against staging Mongo if collections are empty.
4. Smoke: `curl -sS "$STAGING_URL/health"`.
5. E2E against staging:
   ```bash
   BASE_URL=$STAGING_URL API_KEY=sk_test_... LIMIT=60 node scripts/load-rate-limit.mjs
   ```
   Plus manual or CI HTTP checks for create/get/cancel.

## Production deploy

1. Promote the same image/build as staging (`hypertron-api` service in `render.yaml`).
2. Confirm `SWAGGER_ENABLED=false`, `NODE_ENV=production`, OTEL endpoint set if used.
3. Enable alerts above before cutting merchant traffic.
4. Rollback: redeploy previous Render deploy; workers share the same process unless `DISABLE_WORKERS` split is introduced later.

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
