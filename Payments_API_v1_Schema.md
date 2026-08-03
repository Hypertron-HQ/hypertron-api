# Hypertron Payments API v1

Implementation-ready API contract for the Hypertron stablecoin payment gateway.

This document is the contract between Hypertron and external merchant applications. It is intentionally separate from the existing internal dashboard API documented in `hypertron/docs/API.md`.

## 1. Product boundary

Hypertron exposes a Stripe-like payment API:

1. A merchant creates a `Payment` with a server-side API key.
2. Hypertron creates a hosted checkout session.
3. The merchant redirects its customer to `checkout_url`.
4. Hypertron verifies the Stellar transaction and advances the payment lifecycle.
5. Hypertron sends a signed webhook to the merchant.

The public API must use `Payment` as its canonical resource. Existing `PaymentLink` rows remain an internal checkout and attribution mechanism during v1. They must not be exposed as the primary developer abstraction.

## 2. Service and versioning

| Item | Decision |
| --- | --- |
| Public base URL | `https://api.hypertron.xyz/v1` |
| Test environment | Stellar testnet, keys begin with `sk_test_` |
| Live environment | Stellar public network, keys begin with `sk_live_` |
| Content type | `application/json` |
| Timestamp format | ISO 8601 UTC, for example `2026-08-03T12:30:00.000Z` |
| Amount format | Decimal string; never use floating-point numbers |
| ID format | Opaque prefixed IDs such as `pay_01J...`, `evt_01J...` |
| API versioning | Major version in the URL; additive fields are backward compatible |

The current dashboard routes under `/api/*` remain session-authenticated control-plane routes. They are not the public developer API.

## 3. Authentication and headers

### 3.1 Public API authentication

Every public API request except health checks uses a secret key:

```http
Authorization: Bearer sk_test_...
```

Secret keys are environment-scoped. A test key can only create and read test payments; a live key can only create and read live payments.

Do not accept API keys in query parameters or request bodies. Do not log the `Authorization` header.

### 3.2 Required and recommended headers

```http
Content-Type: application/json
Authorization: Bearer sk_test_...
Idempotency-Key: order_ORD123_payment_1
```

| Header | Required | Applies to | Behaviour |
| --- | --- | --- | --- |
| `Authorization` | Yes | All authenticated requests | Bearer secret API key |
| `Content-Type` | Yes | Requests with a body | Must be `application/json` |
| `Idempotency-Key` | Yes | `POST /payments` | 1–255 characters; retained for at least 24 hours |
| `X-Request-Id` | No | All requests | Client-provided tracing ID; server returns its own request ID |

The response always includes:

```http
X-Request-Id: req_01J...
```

### 3.3 API key storage

Generate secrets with a cryptographically secure random generator. Store only a hash of the secret and the visible prefix/last four characters. Show the full secret exactly once in the dashboard response. Never store or return it again.

Recommended key formats:

```text
pk_test_<random>   # optional future browser/publishable key
sk_test_<random>   # server-side test key
pk_live_<random>   # optional future browser/publishable key
sk_live_<random>   # server-side live key
```

v1 only requires `sk_test_` and `sk_live_`. Publishable keys can be reserved without implementing browser-side access.

## 4. Money and asset rules

v1 accepts token-denominated amounts. The `currency` field identifies the Stellar asset to be paid, not a fiat display currency.

Supported v1 currencies:

| Currency | Meaning |
| --- | --- |
| `USDC` | Circle USDC on Stellar |
| `EURC` | EURC on Stellar, when enabled for the environment |
| `XLM` | Native Stellar lumens |

Examples:

```json
{ "amount": "100.00", "currency": "USDC" }
```

```json
{ "amount": "2.5000000", "currency": "XLM" }
```

Rules:

- `amount` is a positive decimal string with no exponent notation.
- Maximum decimal places must match the asset precision: USDC/EURC up to 7, XLM up to 7.
- Leading/trailing whitespace is rejected.
- Zero, negative, NaN, Infinity, and floating-point JSON numbers are rejected.
- Fiat pricing and exchange-rate quotes are out of scope for v1. Add a separate `quote` resource rather than changing the meaning of `currency` later.

## 5. Resource model

### 5.1 Payment object

```json
{
  "id": "pay_01JABC123",
  "object": "payment",
  "environment": "test",
  "status": "created",
  "amount": "100.00",
  "currency": "USDC",
  "description": "Order ORD123",
  "checkout_url": "https://pay.hypertron.xyz/pay/pay_01JABC123",
  "customer": {
    "id": "cus_01JABC456",
    "email": "customer@example.com",
    "name": "Ada Lovelace"
  },
  "metadata": {
    "order_id": "ORD123"
  },
  "transaction": null,
  "failure": null,
  "expires_at": "2026-08-04T12:30:00.000Z",
  "created_at": "2026-08-03T12:30:00.000Z",
  "updated_at": "2026-08-03T12:30:00.000Z",
  "paid_at": null,
  "completed_at": null,
  "canceled_at": null
}
```

Field rules:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Public immutable payment ID |
| `object` | string | Always `payment` |
| `environment` | enum | `test` or `live` |
| `status` | enum | See lifecycle below |
| `amount` | decimal string | Required payment amount |
| `currency` | enum | `USDC`, `EURC`, or `XLM` |
| `description` | string/null | Maximum 500 characters |
| `checkout_url` | URL | Hosted checkout URL |
| `customer` | object/null | Linked or newly created customer |
| `metadata` | object | Up to 50 string key/value pairs |
| `transaction` | object/null | Present after chain verification |
| `failure` | object/null | Present only for failed payments |
| `expires_at` | timestamp/null | Checkout expiry |
| timestamps | timestamp/null | Server-generated lifecycle timestamps |

### 5.2 Transaction object

```json
{
  "network": "testnet",
  "hash": "a1b2c3...",
  "asset_code": "USDC",
  "asset_issuer": "G...",
  "payer_address": "G...",
  "destination_address": "G...",
  "memo": "hpl_...",
  "verified_at": "2026-08-03T12:31:10.000Z"
}
```

The API may expose `asset_issuer` as `null` for XLM. The transaction hash is null until a matching transaction is verified.

### 5.3 Customer object

```json
{
  "id": "cus_01JABC456",
  "object": "customer",
  "email": "customer@example.com",
  "name": "Ada Lovelace",
  "metadata": { "crm_id": "crm_123" },
  "payment_count": 3,
  "lifetime_value": "250.00",
  "lifetime_value_currency": "USDC",
  "last_payment_at": "2026-08-03T12:31:10.000Z",
  "created_at": "2026-07-01T10:00:00.000Z",
  "updated_at": "2026-08-03T12:31:10.000Z"
}
```

Customer identity in v1 is merchant-scoped. If an email is supplied, normalize it to lowercase for lookup. Do not use email as a globally unique key.

## 6. Payment lifecycle

```text
created ───────► pending ───────► confirmed ───────► completed
   │                │                 │
   ├──────────────► canceled          └────────────► failed
   └──────────────► expired
```

| Status | Meaning | Terminal |
| --- | --- | --- |
| `created` | Payment record exists; checkout has been created | No |
| `pending` | Checkout is open and awaiting a customer transaction | No |
| `confirmed` | A matching transaction is detected and validated | No |
| `completed` | Required confirmations/finality reached; payment is accepted | Yes |
| `failed` | Payment cannot be accepted, for example wrong asset or amount | Yes |
| `expired` | Checkout expired before completion | Yes |
| `canceled` | Merchant canceled the payment before completion | Yes |

Allowed transitions:

- `created` → `pending`, `canceled`, or `expired`
- `pending` → `confirmed`, `failed`, `canceled`, or `expired`
- `confirmed` → `completed` or `failed`
- Terminal states never transition again

Every transition creates one immutable `PaymentEvent`. Reconciliation must be idempotent: the same Stellar transaction must never create duplicate completion events.

## 7. Public Payments API

### 7.1 Create a payment

```http
POST /v1/payments
```

Request:

```json
{
  "amount": "100.00",
  "currency": "USDC",
  "description": "Order ORD123",
  "customer": {
    "email": "customer@example.com",
    "name": "Ada Lovelace"
  },
  "metadata": {
    "order_id": "ORD123",
    "cart_id": "CART456"
  },
  "expires_in": 3600
}
```

Request schema:

| Field | Required | Validation |
| --- | --- | --- |
| `amount` | Yes | Positive decimal string |
| `currency` | Yes | `USDC`, `EURC`, or `XLM` |
| `description` | No | String, max 500 characters |
| `customer.email` | No | Valid email, max 320 characters |
| `customer.name` | No | Max 200 characters |
| `customer.metadata` | No | Up to 50 string pairs |
| `metadata` | No | Up to 50 string pairs |
| `expires_in` | No | Integer seconds, 300–86400; default 3600 |

Response `201 Created`: returns a complete `Payment` object in the requested environment.

Server actions:

1. Authenticate the API key and resolve `businessId` from the key.
2. Validate the amount, asset, customer, and metadata.
3. Resolve or create the merchant-scoped customer.
4. Create the canonical `Payment`.
5. Create the internal `PaymentLink` with a unique attribution memo.
6. Set `checkout_url` to the hosted checkout route.
7. Emit `payment.created`.
8. Move the payment to `pending` when the checkout is ready and emit `payment.pending`.

Do not submit a blockchain transaction during this request.

### 7.2 Get a payment

```http
GET /v1/payments/{payment_id}
```

Response `200 OK`: returns the `Payment` object.

The endpoint returns `404` when the payment does not belong to the authenticated merchant/environment. Do not reveal whether the ID exists in another merchant account.

### 7.3 List payments

```http
GET /v1/payments?status=pending&limit=25&starting_after=pay_01J...
```

Query parameters:

| Parameter | Default | Rules |
| --- | --- | --- |
| `status` | all | One lifecycle status |
| `customer_id` | none | Merchant-scoped customer ID |
| `created_after` | none | ISO timestamp |
| `created_before` | none | ISO timestamp |
| `limit` | 25 | Integer 1–100 |
| `starting_after` | none | Cursor from the previous page |

Response:

```json
{
  "object": "list",
  "data": [],
  "has_more": false,
  "next_cursor": null
}
```

Sort by `created_at DESC, id DESC`. Cursor pagination must be stable and must not use page numbers.

### 7.4 Cancel a payment

```http
POST /v1/payments/{payment_id}/cancel
```

Request body: `{}`

Response `200 OK`: returns the updated `Payment` object.

Only `created` and `pending` payments can be canceled. A confirmed or completed payment cannot be canceled; refunds are a separate future capability. Emit `payment.canceled` exactly once.

### 7.5 List payment events

```http
GET /v1/payments/{payment_id}/events
```

Response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "evt_01J...",
      "object": "event",
      "type": "payment.completed",
      "payment_id": "pay_01J...",
      "data": { "object": {} },
      "created_at": "2026-08-03T12:31:10.000Z"
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

## 8. Dashboard control-plane API

These endpoints use the existing Hypertron wallet/Privy session cookies and RBAC membership. They are not authenticated with a merchant secret key.

Recommended route prefix: `/api/developer`.

### API key management

| Method | Route | Role |
| --- | --- | --- |
| `GET` | `/api/developer/api-keys` | Any member |
| `POST` | `/api/developer/api-keys` | Owner/admin |
| `POST` | `/api/developer/api-keys/{id}/rotate` | Owner/admin |
| `POST` | `/api/developer/api-keys/{id}/revoke` | Owner/admin |

Create request:

```json
{
  "name": "Production checkout",
  "environment": "live"
}
```

Create response returns the secret once:

```json
{
  "id": "key_01J...",
  "object": "api_key",
  "name": "Production checkout",
  "environment": "live",
  "public_key": null,
  "secret_key": "sk_live_...",
  "secret_visible_once": true,
  "active": true,
  "created_at": "2026-08-03T12:30:00.000Z",
  "last_used_at": null,
  "revoked_at": null
}
```

List and detail responses must return `secret_key: null` and only `key_prefix`/`last_four` after creation.

### Webhook endpoint management

| Method | Route | Role |
| --- | --- | --- |
| `GET` | `/api/developer/webhook-endpoints` | Any member |
| `POST` | `/api/developer/webhook-endpoints` | Owner/admin |
| `PATCH` | `/api/developer/webhook-endpoints/{id}` | Owner/admin |
| `POST` | `/api/developer/webhook-endpoints/{id}/rotate-secret` | Owner/admin |
| `DELETE` | `/api/developer/webhook-endpoints/{id}` | Owner/admin |
| `GET` | `/api/developer/webhook-endpoints/{id}/deliveries` | Any member |
| `POST` | `/api/developer/webhook-endpoints/{id}/test` | Owner/admin |

Create request:

```json
{
  "url": "https://merchant.example.com/hypertron/webhook",
  "description": "Production order updates",
  "environment": "live",
  "events": [
    "payment.created",
    "payment.pending",
    "payment.completed",
    "payment.failed"
  ]
}
```

Create response returns `signing_secret` once. Store it encrypted at rest because Hypertron must use it to sign future deliveries. Return only `secret_last_four` thereafter.

### Customer API

| Method | Route | Role |
| --- | --- | --- |
| `GET` | `/v1/customers` | Secret API key |
| `GET` | `/v1/customers/{customer_id}` | Secret API key |
| `GET` | `/api/developer/customers` | Dashboard session |

Customer creation is implicit through `POST /v1/payments` in v1. A standalone customer create/update API can be added later without changing payment payloads.

## 9. Webhook contract

### 9.1 Events

v1 events:

- `payment.created`
- `payment.pending`
- `payment.confirmed`
- `payment.completed`
- `payment.failed`
- `payment.expired`
- `payment.canceled`

Each event is emitted once in the event store. Delivery retries do not create new event IDs.

### 9.2 Payload

```json
{
  "id": "evt_01JABC789",
  "object": "event",
  "type": "payment.completed",
  "api_version": "v1",
  "environment": "live",
  "created_at": "2026-08-03T12:31:10.000Z",
  "data": {
    "object": {
      "id": "pay_01JABC123",
      "object": "payment",
      "status": "completed",
      "amount": "100.00",
      "currency": "USDC",
      "checkout_url": "https://pay.hypertron.xyz/pay/pay_01JABC123",
      "customer": {
        "id": "cus_01JABC456",
        "email": "customer@example.com",
        "name": "Ada Lovelace"
      },
      "metadata": { "order_id": "ORD123" },
      "transaction": {
        "network": "public",
        "hash": "a1b2c3...",
        "asset_code": "USDC",
        "payer_address": "G...",
        "destination_address": "G...",
        "memo": "hpl_...",
        "verified_at": "2026-08-03T12:31:10.000Z"
      },
      "failure": null,
      "expires_at": null,
      "created_at": "2026-08-03T12:30:00.000Z",
      "updated_at": "2026-08-03T12:31:10.000Z",
      "paid_at": "2026-08-03T12:31:00.000Z",
      "completed_at": "2026-08-03T12:31:10.000Z",
      "canceled_at": null
    }
  }
}
```

### 9.3 Signing

Send the raw request body unchanged and include:

```http
Hypertron-Signature: t=1785750670,v1=4f3b...
Hypertron-Event-Id: evt_01JABC789
Hypertron-Delivery-Id: whd_01JABC999
```

Signature algorithm:

```text
signed_payload = timestamp + "." + raw_request_body
signature = hex(HMAC-SHA256(signing_secret, signed_payload))
```

Receiver requirements:

1. Read the raw body before JSON parsing.
2. Parse `t` and `v1`.
3. Reject timestamps older than five minutes.
4. Compute HMAC using a constant-time comparison.
5. Deduplicate using the event ID.
6. Return any `2xx` response after safely accepting the event.

### 9.4 Delivery and retry policy

- Timeout: 10 seconds per attempt.
- Consider any `2xx` response successful.
- Retry on network errors, timeout, and `408`, `409`, `425`, `429`, and `5xx`.
- Do not retry `400`–`499` responses except `408`, `409`, `425`, and `429`.
- Suggested retry schedule: 30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours, 24 hours.
- Mark delivery `failed` after the final attempt; retain the response status and truncated response body for debugging.
- Webhook delivery must be asynchronous and must never block payment creation or blockchain reconciliation.

## 10. Error contract

All errors use the same shape:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_amount",
    "message": "amount must be a positive decimal string",
    "param": "amount",
    "request_id": "req_01J..."
  }
}
```

Error types:

| HTTP | Type/code examples |
| --- | --- |
| `400` | `invalid_request_error`, `invalid_amount`, `invalid_currency` |
| `401` | `authentication_error`, `invalid_api_key` |
| `403` | `permission_error`, `environment_mismatch` |
| `404` | `resource_missing`, `payment_not_found` |
| `409` | `idempotency_error`, `invalid_state_transition` |
| `422` | `unprocessable_entity`, `unsupported_asset` |
| `429` | `rate_limit_error` |
| `500` | `api_error` |
| `503` | `service_unavailable`, `blockchain_unavailable` |

Do not return stack traces, database errors, API key material, or cross-merchant resource existence information.

## 11. Logical database schema

The existing `Business` model is the merchant/workspace entity. Add the following models to the core backend database. The exact Prisma syntax can follow the existing MongoDB schema, but these logical fields and constraints are required.

### `ApiKey`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `key_` ID |
| `businessId` | string | Indexed, references `Business` |
| `name` | string | Required, max 100 |
| `environment` | enum | `test` or `live` |
| `keyPrefix` | string | Indexed, non-secret prefix |
| `secretHash` | string | Required, never returned |
| `lastFour` | string | Required |
| `active` | boolean | Default true |
| `lastUsedAt` | timestamp | Nullable |
| `createdAt` | timestamp | Required |
| `revokedAt` | timestamp | Nullable |

Unique index: `(businessId, environment, keyPrefix)`.

### `Payment`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `pay_` ID |
| `businessId` | string | Indexed, references `Business` |
| `environment` | enum | `test` or `live` |
| `status` | enum | Lifecycle status above |
| `amount` | decimal string | Required |
| `currency` | enum | `USDC`, `EURC`, `XLM` |
| `description` | string | Nullable, max 500 |
| `customerId` | string | Nullable, indexed |
| `metadata` | JSON | Default `{}` |
| `checkoutUrl` | string | Required |
| `paymentLinkId` | string | Required, unique internal link |
| `linkMemo` | string | Required, unique attribution memo |
| `destinationAddress` | string | Required Stellar address |
| `payerAddress` | string | Nullable |
| `transactionHash` | string | Nullable, unique when present |
| `assetIssuer` | string | Nullable for XLM |
| `failureCode` | string | Nullable |
| `failureMessage` | string | Nullable, safe public message |
| `expiresAt` | timestamp | Nullable |
| `paidAt` | timestamp | Nullable |
| `completedAt` | timestamp | Nullable |
| `canceledAt` | timestamp | Nullable |
| `createdAt` | timestamp | Required |
| `updatedAt` | timestamp | Required |

Indexes: `(businessId, environment, createdAt)`, `(businessId, status, createdAt)`, `(businessId, customerId)`, `(linkMemo)`.

### `Customer`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `cus_` ID |
| `businessId` | string | Indexed |
| `email` | string | Nullable, normalized lowercase |
| `name` | string | Nullable |
| `metadata` | JSON | Default `{}` |
| `paymentCount` | integer | Default 0 |
| `lifetimeValue` | decimal string | Aggregated per currency or keep currency-specific totals |
| `lastPaymentAt` | timestamp | Nullable |
| `createdAt` | timestamp | Required |
| `updatedAt` | timestamp | Required |

For MVP, enforce uniqueness on `(businessId, email)` only when email is not null. If the database cannot express that partial constraint, resolve customer identity in a transaction or application-level lock.

### `PaymentEvent`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `evt_` ID |
| `businessId` | string | Indexed |
| `paymentId` | string | Indexed |
| `type` | string | Event enum |
| `data` | JSON | Immutable event snapshot |
| `createdAt` | timestamp | Required |

Unique index: `(paymentId, type)` for lifecycle events.

### `WebhookEndpoint`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `we_` ID |
| `businessId` | string | Indexed |
| `environment` | enum | `test` or `live` |
| `url` | string | HTTPS URL; localhost allowed only in test |
| `description` | string | Nullable |
| `events` | string[] | Subscribed event types |
| `signingSecretEncrypted` | string | Encrypted at rest |
| `secretLastFour` | string | Safe display value |
| `active` | boolean | Default true |
| `createdAt` | timestamp | Required |
| `updatedAt` | timestamp | Required |
| `disabledAt` | timestamp | Nullable |

### `WebhookDelivery`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key, public `whd_` ID |
| `businessId` | string | Indexed |
| `endpointId` | string | Indexed |
| `eventId` | string | Indexed |
| `status` | enum | `pending`, `delivered`, `failed` |
| `attemptCount` | integer | Default 0 |
| `nextAttemptAt` | timestamp | Nullable |
| `lastAttemptAt` | timestamp | Nullable |
| `responseStatus` | integer | Nullable |
| `responseBody` | string | Nullable, truncate to 2KB |
| `deliveredAt` | timestamp | Nullable |
| `createdAt` | timestamp | Required |

Unique index: `(endpointId, eventId)`.

### `IdempotencyRecord`

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | Primary key |
| `businessId` | string | Indexed |
| `apiKeyId` | string | Indexed |
| `key` | string | Required |
| `requestHash` | string | Required |
| `responseStatus` | integer | Required |
| `responseBody` | JSON | Required |
| `createdAt` | timestamp | Required |
| `expiresAt` | timestamp | Required |

Unique index: `(businessId, apiKeyId, key)`.

## 12. Blockchain and reconciliation requirements

The listener/reconciler is the source of truth for payment completion, not frontend polling.

For each open payment, reconcile against:

- Stellar network selected by `environment`.
- Expected destination address.
- Expected asset code and issuer.
- Exact expected amount.
- Unique payment memo generated for the internal payment link.
- Transaction validity and required confirmation/finality policy.

When a match is found:

1. Acquire a payment-level lock or use an atomic compare-and-set.
2. Store the transaction hash and payer address.
3. Transition `pending` → `confirmed`.
4. Emit `payment.confirmed`.
5. After finality policy passes, transition `confirmed` → `completed`.
6. Update customer aggregates.
7. Emit `payment.completed`.
8. Enqueue webhook deliveries.

Wrong asset, insufficient amount, expired checkout, duplicate transaction, and invalid destination must produce explicit internal failure codes. Never mark a payment completed from an unverified client callback.

## 13. Rate limits and operational requirements

Initial limits:

| Scope | Limit |
| --- | --- |
| Payment creation | 60 requests/minute per API key |
| Read endpoints | 300 requests/minute per API key |
| Dashboard control-plane routes | 120 requests/minute per user |
| Webhook body | 256 KB maximum |
| Metadata | 50 keys, 500 characters per key/value |

Return these headers on rate-limited responses:

```http
Retry-After: 30
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1785750700
```

Required operational components:

- Background queue for blockchain reconciliation.
- Background queue for webhook delivery.
- Dead-letter or retry visibility for failed jobs.
- Structured logs with `request_id`, `business_id`, `payment_id`, and `event_id`.
- Metrics for payment creation, completion latency, reconciliation errors, webhook success rate, and API errors.
- Health endpoint that checks process health separately from database/blockchain dependency health.

## 14. Build order for the backend team

1. Add prefixed public IDs and the five new persistence models: `ApiKey`, `Payment`, `Customer`, `PaymentEvent`, and `IdempotencyRecord`.
2. Add `WebhookEndpoint` and `WebhookDelivery` with a queue abstraction.
3. Implement API-key hashing, environment scoping, role checks, and request IDs.
4. Implement `POST /v1/payments` with idempotency and internal `PaymentLink` creation.
5. Implement payment read/list/cancel endpoints and cursor pagination.
6. Build the reconciliation state machine with atomic transitions.
7. Emit immutable events and implement signed webhook delivery/retries.
8. Add dashboard API-key, webhook, payment, and delivery-log routes.
9. Add contract/integration tests for every lifecycle transition and webhook signature.
10. Publish an OpenAPI document generated from the controllers and DTOs.

## 15. Definition of done for v1

- A merchant can create separate test and live secret keys.
- `POST /v1/payments` returns the same payment for repeated requests with the same idempotency key.
- A customer can complete a hosted Stellar checkout.
- The reconciler verifies the exact asset, amount, destination, and memo.
- A payment reaches `completed` only through server-side reconciliation.
- Every state transition creates one immutable event.
- A subscribed webhook receives a signed `payment.completed` event.
- Webhook delivery retries are observable from the dashboard.
- API keys, payment IDs, customer IDs, and event IDs never leak across merchants.
- Tests cover authentication, authorization, validation, idempotency, pagination, lifecycle transitions, signature verification, retries, and duplicate blockchain transactions.

## 16. cURL command reference

Set these variables before running the public API examples:

```bash
export HYPERTRON_API_BASE="https://api.hypertron.xyz/v1"
export HYPERTRON_SECRET_KEY="sk_test_replace_me"
export PAYMENT_ID="pay_replace_me"
```

### Health check

```bash
curl --fail-with-body -sS \
  "${HYPERTRON_API_BASE%/v1}/health"
```

### Create a payment

```bash
curl --fail-with-body -sS -X POST \
  "${HYPERTRON_API_BASE}/payments" \
  -H "Authorization: Bearer ${HYPERTRON_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order_ORD123_payment_1" \
  -d '{
    "amount": "100.00",
    "currency": "USDC",
    "description": "Order ORD123",
    "customer": {
      "email": "customer@example.com",
      "name": "Ada Lovelace"
    },
    "metadata": {
      "order_id": "ORD123"
    },
    "expires_in": 3600
  }'
```

### Get a payment

```bash
curl --fail-with-body -sS \
  "${HYPERTRON_API_BASE}/payments/${PAYMENT_ID}" \
  -H "Authorization: Bearer ${HYPERTRON_SECRET_KEY}"
```

### List payments

```bash
curl --fail-with-body -sS \
  "${HYPERTRON_API_BASE}/payments?status=pending&limit=25" \
  -H "Authorization: Bearer ${HYPERTRON_SECRET_KEY}"
```

### Cancel a payment

```bash
curl --fail-with-body -sS -X POST \
  "${HYPERTRON_API_BASE}/payments/${PAYMENT_ID}/cancel" \
  -H "Authorization: Bearer ${HYPERTRON_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### List payment events

```bash
curl --fail-with-body -sS \
  "${HYPERTRON_API_BASE}/payments/${PAYMENT_ID}/events" \
  -H "Authorization: Bearer ${HYPERTRON_SECRET_KEY}"
```

### Create a dashboard API key

Dashboard control-plane routes use the existing authenticated session cookie, not a secret API key.

```bash
export HYPERTRON_SESSION_COOKIE="ht_privy=replace_with_dashboard_session"

curl --fail-with-body -sS -X POST \
  "${HYPERTRON_API_BASE%/v1}/api/developer/api-keys" \
  -b "${HYPERTRON_SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production checkout",
    "environment": "live"
  }'
```

### Create a webhook endpoint

```bash
curl --fail-with-body -sS -X POST \
  "${HYPERTRON_API_BASE%/v1}/api/developer/webhook-endpoints" \
  -b "${HYPERTRON_SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://merchant.example.com/hypertron/webhook",
    "description": "Production order updates",
    "environment": "live",
    "events": [
      "payment.created",
      "payment.pending",
      "payment.completed",
      "payment.failed"
    ]
  }'
```

### List webhook deliveries

```bash
export WEBHOOK_ENDPOINT_ID="we_replace_me"

curl --fail-with-body -sS \
  "${HYPERTRON_API_BASE%/v1}/api/developer/webhook-endpoints/${WEBHOOK_ENDPOINT_ID}/deliveries" \
  -b "${HYPERTRON_SESSION_COOKIE}"
```

The secret returned when creating a webhook endpoint and the secret key returned when creating an API key are displayed once. Save them securely; subsequent cURL requests cannot retrieve them.
