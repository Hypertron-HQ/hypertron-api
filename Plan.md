# HyperTone Payments API — Architecture & Implementation Guide

> **Internal codename:** HyperTone API  
> **Public product name:** Hypertron Payments API  
> **Base URL:** `https://api.hypertron.xyz/v1`  
> **Framework:** NestJS (TypeScript)  
> **Status:** Pre-implementation blueprint

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Project Boilerplate Plan](#3-project-boilerplate-plan)
4. [Recommended Project Structure](#4-recommended-project-structure)
5. [Module Architecture](#5-module-architecture)
6. [Dependency Injection Strategy](#6-dependency-injection-strategy)
7. [Configuration Management](#7-configuration-management)
8. [API Gateway Design](#8-api-gateway-design)
9. [Security Strategy](#9-security-strategy)
10. [Database Layer](#10-database-layer)
11. [Payment Lifecycle & State Machine](#11-payment-lifecycle--state-machine)
12. [Blockchain Reconciliation](#12-blockchain-reconciliation)
13. [Webhook Delivery System](#13-webhook-delivery-system)
14. [Idempotency System](#14-idempotency-system)
15. [Reusable Utilities & Shared Abstractions](#15-reusable-utilities--shared-abstractions)
16. [Error Handling Strategy](#16-error-handling-strategy)
17. [Logging, Monitoring & Tracing](#17-logging-monitoring--tracing)
18. [Rate Limiting](#18-rate-limiting)
19. [Testing Strategy](#19-testing-strategy)
20. [Deployment & Production Readiness](#20-deployment--production-readiness)
21. [Phased Implementation Roadmap](#21-phased-implementation-roadmap)
22. [Additional Recommendations](#22-additional-recommendations)

---

## 1. Executive Summary

The HyperTone Payments API is a production-grade, Stripe-inspired payment gateway that wraps Hypertron's Stellar-based stablecoin checkout infrastructure behind a clean merchant-facing REST API. It replaces the existing minimal Express proof-of-concept (`backend/src/index.js`) with an enterprise NestJS service designed for correctness, security, and extensibility.

The system has two distinct authentication planes:

| Plane | Auth mechanism | Route prefix |
|-------|---------------|--------------|
| **Public Payments API** | Bearer secret API key (`sk_test_*` / `sk_live_*`) | `/v1/*` |
| **Dashboard Control-Plane** | Freighter `ht_dashboard` cookie (shared AUTH_SECRET with core) | `/api/developer/*` |

Core functional responsibilities:

- Merchant API key lifecycle (create, rotate, revoke) with secure one-way hashing
- Payment object creation, lifecycle management, and cursor-paginated listing
- Internal `PaymentLink` creation as a Stellar checkout attribution mechanism
- Stellar blockchain reconciliation as the authoritative source of payment completion
- Signed, retriable, observable webhook delivery
- Idempotency enforcement on `POST /v1/payments`
- Customer identity management (merchant-scoped)
- Structured observability via structured logs, metrics, and distributed traces

---

### 2. Key architectural decisions

- **Single NestJS application** with both the HTTP server and background workers. Workers run in the same process using BullMQ processors, or can be extracted to a separate process for scaling.
- **Monorepo-adjacent layout** — the `hypertron-api` repo is self-contained but designed to eventually be consumed as a workspace package.
- **No shared mutable state in the gateway** — all state lives in MongoDB. Worker idempotency is enforced via atomic database operations.
- **Dual-plane routing** — `/v1/*` routes are authenticated via `ApiKeyGuard`; `/api/developer/*` routes use Freighter `ht_dashboard` cookie auth (shared with core).

---

## 3. Project Boilerplate Plan

Follow these steps in order before writing any business logic. Each step should be committed independently.

### Step 1 — Scaffold the NestJS project

```bash
npx @nestjs/cli new hypertron-api --package-manager pnpm --strict
```

Choose `pnpm`. Remove the default `app.controller.spec.ts` and `app.service.ts` placeholders.

### Step 2 — Install core dependencies

```bash
# Runtime
pnpm add @nestjs/config @nestjs/throttler @nestjs/terminus
pnpm add @prisma/client prisma
pnpm add @nestjs/bullmq bullmq
pnpm add helmet
pnpm add class-validator class-transformer
pnpm add @nestjs/swagger swagger-ui-express
pnpm add ulid                        # prefixed opaque ID generation
pnpm add bcrypt                      # API key hashing
pnpm add @types/bcrypt -D
pnpm add pino pino-http nestjs-pino  # structured logging
pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node

# Dev / build
pnpm add -D @types/node ts-node typescript
pnpm add -D jest @nestjs/testing ts-jest supertest @types/supertest
```

### Step 3 — Configure TypeScript (`tsconfig.json`)

Enable strict mode, `experimentalDecorators`, `emitDecoratorMetadata`, and path aliases:

```json
{
  "compilerOptions": {
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

### Step 4 — Initialise Prisma

```bash
npx prisma init --datasource-provider mongodb
```

Define all six models (`ApiKey`, `Payment`, `Customer`, `PaymentEvent`, `WebhookEndpoint`, `WebhookDelivery`, `IdempotencyRecord`) in `prisma/schema.prisma` before running any migrations. See Section 10 for the complete schema design.

### Step 5 — Set up environment handling

Create `.env.example` with every required variable. Use `@nestjs/config` with Joi schema validation to fail fast on startup if required vars are missing. Never commit `.env`.

### Step 6 — Wire up global infrastructure

In `main.ts`:
- Enable `ValidationPipe` globally with `whitelist: true`, `forbidNonWhitelisted: true`, and `transform: true`
- Mount `helmet()` before any route handlers
- Configure CORS explicitly (not wildcard in production)
- Mount `pino-http` request logger
- Set global `APP_VERSION` prefix
- Register the OpenAPI document

### Step 7 — Verify the scaffold compiles and health check works

```bash
pnpm build && pnpm start
curl http://localhost:3000/health
```

---

## 4. Recommended Project Structure

```
hypertron-api/
├── prisma/
│   └── schema.prisma                  # All Prisma models
├── src/
│   ├── main.ts                        # Bootstrap, global middleware
│   ├── app.module.ts                  # Root module
│   │
│   ├── common/                        # Shared abstractions (no business logic)
│   │   ├── config/
│   │   │   ├── app.config.ts
│   │   │   ├── database.config.ts
│   │   │   ├── queue.config.ts
│   │   │   └── stellar.config.ts
│   │   ├── decorators/
│   │   │   ├── api-key-auth.decorator.ts
│   │   │   ├── current-merchant.decorator.ts
│   │   │   └── raw-body.decorator.ts
│   │   ├── dto/
│   │   │   └── paginated-list.dto.ts
│   │   ├── exceptions/
│   │   │   ├── hypertron.exception.ts
│   │   │   └── hypertron-exception.filter.ts
│   │   ├── guards/
│   │   │   ├── api-key.guard.ts
│   │   │   └── session.guard.ts
│   │   ├── interceptors/
│   │   │   ├── request-id.interceptor.ts
│   │   │   └── response-transform.interceptor.ts
│   │   ├── pipes/
│   │   │   └── decimal-amount.pipe.ts
│   │   ├── middleware/
│   │   │   └── raw-body.middleware.ts
│   │   └── utils/
│   │       ├── id-generator.ts        # Prefixed ULID factory
│   │       ├── crypto.util.ts         # Key hashing, HMAC signing
│   │       └── amount.util.ts         # Decimal string validation
│   │
│   ├── infrastructure/
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts
│   │   │   └── prisma.service.ts
│   │   ├── queue/
│   │   │   ├── queue.module.ts
│   │   │   └── queue.constants.ts    # Queue name enums
│   │   └── stellar/
│   │       ├── stellar.module.ts
│   │       └── stellar-horizon.service.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── api-key.service.ts     # Hash, verify, resolve merchant
│   │   │   └── api-key.repository.ts
│   │   │
│   │   ├── payments/
│   │   │   ├── payments.module.ts
│   │   │   ├── payments.controller.ts # /v1/payments
│   │   │   ├── payments.service.ts
│   │   │   ├── payments.repository.ts
│   │   │   ├── dto/
│   │   │   │   ├── create-payment.dto.ts
│   │   │   │   ├── list-payments.dto.ts
│   │   │   │   └── payment-response.dto.ts
│   │   │   └── payment-state-machine.ts
│   │   │
│   │   ├── customers/
│   │   │   ├── customers.module.ts
│   │   │   ├── customers.controller.ts  # /v1/customers
│   │   │   ├── customers.service.ts
│   │   │   └── customers.repository.ts
│   │   │
│   │   ├── events/
│   │   │   ├── events.module.ts
│   │   │   ├── events.service.ts        # Emit + store PaymentEvents
│   │   │   └── events.repository.ts
│   │   │
│   │   ├── reconciler/
│   │   │   ├── reconciler.module.ts
│   │   │   ├── reconciler.processor.ts  # BullMQ processor
│   │   │   ├── reconciler.service.ts    # State machine driver
│   │   │   └── stellar-verifier.ts
│   │   │
│   │   ├── webhooks/
│   │   │   ├── webhooks.module.ts
│   │   │   ├── webhook-endpoint.service.ts
│   │   │   ├── webhook-delivery.service.ts
│   │   │   ├── webhook.processor.ts     # BullMQ processor
│   │   │   └── webhook-signer.ts
│   │   │
│   │   ├── idempotency/
│   │   │   ├── idempotency.module.ts
│   │   │   └── idempotency.service.ts
│   │   │
│   │   └── developer/
│   │       ├── developer.module.ts
│   │       ├── api-keys.controller.ts   # /api/developer/api-keys
│   │       ├── webhook-endpoints.controller.ts
│   │       └── customers-dashboard.controller.ts
│   │
│   └── health/
│       ├── health.module.ts
│       └── health.controller.ts         # /health
│
├── test/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .env.example
├── Payments_API_v1_Schema.md
└── API_GATEWAY.md
```

---

## 5. Module Architecture

Every NestJS feature is encapsulated in its own module. Modules declare what they export; other modules import only what they need. No module reaches across its boundary via direct class instantiation.

### Module dependency graph

```
AppModule
├── ConfigModule (global)
├── PrismaModule (global)
├── QueueModule (global)
├── HealthModule
├── AuthModule
│   └── exports: ApiKeyService
├── IdempotencyModule
│   └── imports: PrismaModule
├── EventsModule
│   └── imports: PrismaModule
├── CustomersModule
│   └── imports: PrismaModule, EventsModule
├── PaymentsModule
│   └── imports: AuthModule, CustomersModule, EventsModule,
│               IdempotencyModule, WebhooksModule, QueueModule
├── WebhooksModule
│   └── imports: PrismaModule, QueueModule, EventsModule
├── ReconcilerModule
│   └── imports: PrismaModule, QueueModule, EventsModule,
│               WebhooksModule, CustomersModule, StellarModule
├── StellarModule
│   └── exports: StellarHorizonService
└── DeveloperModule
    └── imports: AuthModule, WebhooksModule, CustomersModule, PrismaModule
```

### Module responsibility rules

| Module | Owns | Must NOT |
|--------|------|---------|
| `AuthModule` | API key hashing, lookup, environment resolution | Touch Payment rows directly |
| `PaymentsModule` | Create/read/cancel Payment, idempotency | Call Stellar directly |
| `ReconcilerModule` | Blockchain verification, state transitions | Accept inbound HTTP requests |
| `WebhooksModule` | Endpoint CRUD, delivery queuing, signing | Modify payment status |
| `EventsModule` | Append-only event store | Modify other resource rows |
| `IdempotencyModule` | Store and replay idempotency records | Know about Payment semantics |
| `DeveloperModule` | Dashboard CRUD surfaces | Use API key auth |

---

## 6. Dependency Injection Strategy

### 6.1 Custom providers

**`ID_GENERATOR`** — An injection token for the ULID-based prefixed ID factory. Injecting via token (not class) keeps the implementation swappable in tests.

```typescript
// common/utils/id-generator.ts
export const ID_GENERATOR = 'ID_GENERATOR';

export type IdGenerator = (prefix: string) => string;

export const idGeneratorProvider = {
  provide: ID_GENERATOR,
  useFactory: (): IdGenerator => (prefix: string) => `${prefix}_${ulid()}`,
};
```

**`CRYPTO_SERVICE`** — Injection token for key hashing/HMAC operations. Backed by Node's built-in `crypto` module; can be replaced with a KMS-backed implementation without touching callers.

**`STELLAR_CLIENT`** — Wraps the Stellar SDK Horizon/Soroban RPC client. Injected as a custom async factory that reads configuration and initialises the network once.

### 6.2 Global modules

`PrismaModule`, `ConfigModule`, and `QueueModule` are decorated with `@Global()`. All other modules inject these without needing to re-import them.

### 6.3 Shared services pattern

Services that are used across many modules (e.g., `EventsService`, `IdempotencyService`) are exported from their feature module and imported by consumers. Avoid circular imports by ensuring the dependency graph is a DAG.

### 6.4 Dynamic modules for configuration-sensitive providers

Use NestJS `forRootAsync` pattern for modules that require async configuration:

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    connection: config.get('REDIS_URL'),
  }),
  inject: [ConfigService],
});
```

---

## 7. Configuration Management

### 7.1 Environment variables

All configuration is loaded via `@nestjs/config` with a Joi validation schema. The application refuses to start if required variables are absent or malformed.

```
# Application
NODE_ENV=development|test|production
PORT=3000
APP_URL=https://api.hypertron.xyz
CHECKOUT_BASE_URL=https://pay.hypertron.xyz

# Database
DATABASE_URL=mongodb+srv://...

# Redis (for BullMQ queues)
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
STELLAR_TESTNET_DESTINATION_KEYPAIR=S...
STELLAR_MAINNET_DESTINATION_KEYPAIR=S...

# Security
API_KEY_SECRET_SALT_ROUNDS=12
WEBHOOK_SECRET_ENCRYPTION_KEY=<32-byte-hex>

# Rate limiting
RATE_LIMIT_PAYMENT_CREATE_PER_MIN=60
RATE_LIMIT_READ_PER_MIN=300
RATE_LIMIT_DASHBOARD_PER_MIN=120
```

### 7.2 Config namespaces

Register typed configuration namespaces using NestJS's `registerAs`:

```typescript
// common/config/stellar.config.ts
export default registerAs('stellar', () => ({
  testnetUrl: process.env.STELLAR_TESTNET_HORIZON_URL,
  mainnetUrl: process.env.STELLAR_MAINNET_HORIZON_URL,
}));
```

Inject with `ConfigService` using the namespace key: `config.get<StellarConfig>('stellar')`.

### 7.3 Secret management in production

- Never store raw API signing secrets. Use encrypted fields (AES-256-GCM) for `WebhookEndpoint.signingSecretEncrypted` with the key stored in a secret manager (AWS Secrets Manager, GCP Secret Manager, Doppler).
- Rotate the `WEBHOOK_SECRET_ENCRYPTION_KEY` using envelope encryption — store an encrypted copy of the data key alongside each webhook secret.
- For MongoDB connection strings and Redis URLs, use the cloud provider's secret injection (e.g., Render's environment groups, Railway's shared variables).

### 7.4 Application initialisation sequence

```
1. Load and validate environment (ConfigModule)
2. Connect to MongoDB (PrismaModule onModuleInit)
3. Connect to Redis and register BullMQ queues (QueueModule)
4. Start OpenTelemetry SDK (main.ts before bootstrap)
5. Register global pipes, guards, interceptors, filters
6. Start HTTP server
7. Start BullMQ processors (in-process)
8. Log startup summary (environment, version, port)
```

---

## 8. API Gateway Design

### 8.1 Routing overview

| Method | Path | Auth | Module |
|--------|------|------|--------|
| `GET` | `/health` | None | HealthModule |
| `POST` | `/v1/payments` | API key | PaymentsModule |
| `GET` | `/v1/payments` | API key | PaymentsModule |
| `GET` | `/v1/payments/:id` | API key | PaymentsModule |
| `POST` | `/v1/payments/:id/cancel` | API key | PaymentsModule |
| `GET` | `/v1/payments/:id/events` | API key | EventsModule |
| `GET` | `/v1/customers` | API key | CustomersModule |
| `GET` | `/v1/customers/:id` | API key | CustomersModule |
| `GET` | `/api/developer/api-keys` | Session | DeveloperModule |
| `POST` | `/api/developer/api-keys` | Session (Owner/Admin) | DeveloperModule |
| `POST` | `/api/developer/api-keys/:id/rotate` | Session (Owner/Admin) | DeveloperModule |
| `POST` | `/api/developer/api-keys/:id/revoke` | Session (Owner/Admin) | DeveloperModule |
| `GET` | `/api/developer/webhook-endpoints` | Session | DeveloperModule |
| `POST` | `/api/developer/webhook-endpoints` | Session (Owner/Admin) | DeveloperModule |
| `PATCH` | `/api/developer/webhook-endpoints/:id` | Session (Owner/Admin) | DeveloperModule |
| `POST` | `/api/developer/webhook-endpoints/:id/rotate-secret` | Session (Owner/Admin) | DeveloperModule |
| `DELETE` | `/api/developer/webhook-endpoints/:id` | Session (Owner/Admin) | DeveloperModule |
| `GET` | `/api/developer/webhook-endpoints/:id/deliveries` | Session | DeveloperModule |
| `POST` | `/api/developer/webhook-endpoints/:id/test` | Session (Owner/Admin) | DeveloperModule |
| `GET` | `/api/developer/customers` | Session | DeveloperModule |

### 8.2 Request validation pipeline

Every inbound request travels through this pipe:

```
Request
  ↓ RawBodyMiddleware (preserve body for idempotency hash)
  ↓ RequestIdInterceptor (attach/generate X-Request-Id)
  ↓ PinoHttpLogger (log request start)
  ↓ ApiKeyGuard or SessionGuard
  ↓ ThrottlerGuard (rate limiting)
  ↓ ValidationPipe (class-validator on DTOs)
  ↓ Controller method
  ↓ ResponseTransformInterceptor (envelope + camelCase→snake_case)
  ↓ HypertronExceptionFilter (error shaping)
Response
```

### 8.3 Request validation rules

Use `class-validator` decorators in DTOs. Key custom validators:

- **`@IsDecimalString()`** — Ensures `amount` is a positive decimal string with no exponent, no leading/trailing whitespace, and no floating-point JSON number. Precision is validated against the currency (USDC/EURC/XLM: max 7 decimal places).
- **`@IsPaymentCurrency()`** — Validates `currency` against the supported enum.
- **`@IsIdempotencyKey()`** — Validates 1–255 character string from the `Idempotency-Key` header.
- **`@IsMetadataObject()`** — Validates up to 50 string key/value pairs with max 500 chars each.

### 8.4 Response transformation

The `ResponseTransformInterceptor` does not wrap successful responses — the API contract already uses flat objects and list envelopes (`{ object, data, has_more, next_cursor }`). The interceptor's job is:

1. Ensure the `X-Request-Id` header is always present on responses
2. Strip any internal fields (e.g., `secretHash`, `signingSecretEncrypted`) that must never be serialised
3. Serialise timestamps to ISO 8601 UTC format
4. Transform `null` values consistently (included, not omitted)

### 8.5 Cursor pagination

All list endpoints use cursor pagination. Implement a shared `CursorPaginationService`:

- Default `limit=25`, max `limit=100`
- Sort order: `createdAt DESC, id DESC`
- The cursor encodes the `createdAt` + `id` pair, base64-encoded (opaque to clients)
- `has_more` is determined by fetching `limit + 1` rows and checking if the extra row exists
- `next_cursor` is `null` when no more results exist

### 8.6 Downstream service communication

The gateway does not call downstream HTTP services for payment processing — all business logic runs in-process. The two external I/O surfaces are:

1. **MongoDB** via Prisma — all transactional data
2. **Stellar Horizon / Soroban RPC** — blockchain verification (read-only from the gateway; writes are only during Stellar account setup)

`StellarHorizonService` wraps the Stellar SDK with:
- Configurable timeouts (default 10 seconds)
- Automatic retry with exponential backoff for network errors
- Circuit-breaker pattern to avoid hammering a degraded Horizon node
- Environment selection (`testnet` vs `mainnet`) driven by the payment's `environment` field

### 8.7 Retries and timeouts

| Operation | Timeout | Max retries |
|-----------|---------|-------------|
| MongoDB query | 5 000 ms | 3 (driver-level) |
| Horizon API call | 10 000 ms | 3 with exponential backoff |
| Webhook delivery | 10 000 ms | 6 (see retry schedule) |
| BullMQ job | 30 000 ms | Configured per queue |

### 8.8 API versioning

Version is encoded in the URL (`/v1`). NestJS versioning via `@Controller('v1/payments')` at the controller level. Additive changes (new optional fields) are backward-compatible and do not require a version bump. Breaking changes require a new controller tree under `/v2`.

---

## 9. Security Strategy

### 9.1 API key design

**Key format**

```
sk_test_<22-char base58 or urlsafe base64 random token>
sk_live_<22-char base58 or urlsafe base64 random token>
```

Generate using `crypto.randomBytes(32)`. The full key is shown once and never stored.

**Storage**

Store only:
- `keyPrefix` — the `sk_test_` or `sk_live_` prefix (for display and lookup)
- `lastFour` — last four characters of the raw key (for display)
- `secretHash` — `bcrypt(rawKey, 12)` — used for verification

Never store the raw key. Never return `secretHash` in any response.

**Lookup flow**

Incoming `Authorization: Bearer sk_test_abc123` →
1. Extract the prefix (`sk_test_`) from the token and query the `ApiKey` table by `keyPrefix` + `businessId` (use a fast prefix index, not a full bcrypt scan).
2. Load the candidate `ApiKey` records (there should be very few per prefix).
3. `bcrypt.compare(rawKey, storedHash)` for each candidate.
4. If matched and `active=true`: resolve `businessId` and `environment`.
5. Update `lastUsedAt` asynchronously (fire-and-forget, do not block the request).

For performance at scale, consider a two-layer approach: store a fast SHA-256 index hash for initial filtering, then use bcrypt only for final verification.

**Environment scoping enforcement**

Every `Payment` row carries an `environment` field. When a request is authenticated, the resolved environment from the API key is attached to the request context. Every repository method must include `environment` in its query predicate. This is enforced via the `@CurrentMerchant()` decorator which provides `{ businessId, environment }`.

### 9.2 Secure headers

Use `helmet()` with the following configuration:

```typescript
app.use(helmet({
  contentSecurityPolicy: false,       // API-only, no HTML
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
```

Always set:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (handled by Helmet HSTS)
- `X-Request-Id` on every response

### 9.3 Authentication guard implementation

`ApiKeyGuard` (applied to all `/v1` controllers):
1. Extract the `Authorization` header; reject with `401` if missing
2. Reject keys passed in query parameters or body
3. Never log the raw key — log only the `keyPrefix` and `lastFour`
4. Attach resolved `{ businessId, environment, apiKeyId }` to `request.merchant`
5. The guard must be fast enough to not add meaningful latency — target < 5 ms for the bcrypt comparison path

`SessionGuard` (applied to all `/api/developer` controllers):
- Delegates to the existing Privy/wallet session validation logic from the main backend
- Attaches `{ userId, businessId, role }` to the request
- RBAC check: `Owner/Admin` actions use a `@Roles('owner', 'admin')` decorator combined with a `RolesGuard`

### 9.4 Idempotency key security

The `Idempotency-Key` is scoped to `(businessId, apiKeyId, key)`. A key from one merchant cannot collide with another's. The stored `requestHash` (SHA-256 of the serialised request body) is used to detect request body mismatches on replay — return `409 idempotency_error` if the key exists with a different request hash.

### 9.5 Cross-merchant isolation

Every repository method accepts `businessId` as a required parameter and includes it in every query predicate. This is enforced by convention and verified by integration tests. A `404` is returned for any resource not belonging to the authenticated merchant — never `403`, to avoid leaking existence information.

### 9.6 Webhook signing security

- The `signingSecret` is generated once with `crypto.randomBytes(32).toString('hex')`.
- It is shown once in the create response (`signing_secret`).
- It is stored encrypted at rest using AES-256-GCM with the `WEBHOOK_SECRET_ENCRYPTION_KEY`.
- The `WebhookSigner` decrypts the secret only at delivery time, never caching it in memory longer than needed.
- Signature format: `t=<unix_seconds>,v1=<hex_hmac_sha256>`

### 9.7 Input sanitisation

- `ValidationPipe` with `whitelist: true` strips all undeclared properties.
- `forbidNonWhitelisted: true` returns `400` for unknown properties.
- `transform: true` coerces string query params to their declared types.
- The `DecimalAmountPipe` is a dedicated pipe that validates `amount` after the standard ValidationPipe, applying currency-specific precision rules.

### 9.8 SQL/NoSQL injection prevention

Using Prisma ORM with typed queries eliminates raw query injection risk. All dynamic values are passed as parameters to Prisma's fluent API. MongoDB `$where` and raw aggregation pipelines are forbidden.

### 9.9 Rate limiting and abuse prevention

See Section 18 for detailed rate limiting design.

---

## 10. Database Layer

### 10.1 Prisma with MongoDB

The existing Hypertron backend uses MongoDB with Prisma. This service extends that schema with seven new models. Since MongoDB is a document store, the Prisma schema uses `@db.ObjectId` for relational-style lookups but the actual references are enforced at the application layer.

### 10.2 PrismaService

```typescript
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

Declare `PrismaModule` as `@Global()` so it does not need to be imported everywhere.

### 10.3 Repository pattern

Each module owns a dedicated repository class. Repositories:
- Receive a `PrismaService` via constructor injection
- Accept `businessId` and `environment` as required parameters on all read/write methods
- Return domain objects (raw Prisma types or mapped DTOs — consistent within the module)
- Never throw HTTP exceptions — throw domain exceptions that the service layer catches

```typescript
@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdAndMerchant(
    id: string,
    businessId: string,
    environment: Environment,
  ): Promise<Payment | null> { ... }
}
```

### 10.4 Required indexes

Beyond the indexes specified in the schema, add these compound indexes in MongoDB:

```
Payment:  { businessId: 1, environment: 1, createdAt: -1, _id: -1 }  ← list pagination
Payment:  { linkMemo: 1 }                                              ← unique, reconciler lookup
ApiKey:   { keyPrefix: 1, businessId: 1 }                             ← auth lookup
IdempotencyRecord: { businessId: 1, apiKeyId: 1, key: 1 }            ← unique, fast lookup
IdempotencyRecord: { expiresAt: 1 }                                   ← TTL index for cleanup
WebhookDelivery: { endpointId: 1, eventId: 1 }                       ← unique, idempotency
```

### 10.5 Atomic state transitions

MongoDB does not support multi-document ACID transactions by default. For payment state transitions:

1. Use `prisma.payment.updateMany({ where: { id, status: expectedCurrentStatus }, data: { status: newStatus } })`.
2. Check the `count` in the result — if `0`, the transition was a no-op (another process won the race).
3. This is a compare-and-set pattern that avoids a separate lock.

For operations that must update multiple documents atomically (e.g., updating `Payment` status and appending a `PaymentEvent`), use MongoDB multi-document transactions with `prisma.$transaction([...])`.

---

## 11. Payment Lifecycle & State Machine

### 11.1 State transition map

```
created ──────────────────────────────────────► canceled (terminal)
   │                                            ▲
   ▼                                            │
pending ──────────────────────────────────────► canceled (terminal)
   │                                            │
   ├──────────────────────────────────────────► failed (terminal)
   │                                            │
   ├──────────────────────────────────────────► expired (terminal)
   │
   ▼
confirmed
   │
   ├──────────────────────────────────────────► failed (terminal)
   │
   ▼
completed (terminal)
```

### 11.2 PaymentStateMachine service

Implement a dedicated `PaymentStateMachine` class with a method per allowed transition:

```typescript
class PaymentStateMachine {
  async toPending(paymentId: string, businessId: string): Promise<Payment>
  async toConfirmed(paymentId: string, txData: TransactionData): Promise<Payment>
  async toCompleted(paymentId: string): Promise<Payment>
  async toFailed(paymentId: string, code: string, message: string): Promise<Payment>
  async toExpired(paymentId: string): Promise<Payment>
  async toCanceled(paymentId: string, businessId: string): Promise<Payment>
}
```

Each method:
1. Validates the transition is allowed from the current state (throws `409 invalid_state_transition` if not).
2. Performs the atomic compare-and-set update.
3. Sets the appropriate lifecycle timestamp (`paidAt`, `completedAt`, `canceledAt`, etc.).
4. Calls `EventsService.emit(paymentId, eventType, paymentSnapshot)`.
5. Returns the updated payment.

### 11.3 POST /v1/payments server actions

Exactly following the spec:
1. `ApiKeyGuard` resolves `{ businessId, environment, apiKeyId }`.
2. `IdempotencyService.check(businessId, apiKeyId, idempotencyKey, requestHash)` — return cached response if found.
3. Validate DTO (`CreatePaymentDto`) including amount precision for the given currency.
4. Resolve or create the merchant-scoped customer (upsert by `(businessId, email.toLowerCase())`).
5. Generate IDs: `pay_${ulid()}`, `cus_${ulid()}` (if new customer), `evt_${ulid()}`.
6. Generate `linkMemo` — a unique Stellar memo string prefixed with `hpl_`.
7. Create the `Payment` with `status=created` and `checkout_url=CHECKOUT_BASE_URL/pay/${paymentId}`.
8. Create the internal `PaymentLink` record (existing data model).
9. Emit `payment.created` event.
10. Transition to `pending` and emit `payment.pending`.
11. `IdempotencyService.store(...)` with the response.
12. Return `201` with the complete `Payment` object.

Steps 4–11 run in a single `prisma.$transaction` where possible.

### 11.4 Expiry handling

A scheduled BullMQ job (`expiry-checker`) runs every minute and queries for payments where `expiresAt < now() AND status IN ['created', 'pending']`. For each, it calls `PaymentStateMachine.toExpired()`. This job must be idempotent.

---

## 12. Blockchain Reconciliation

### 12.1 Architecture

The reconciler is a BullMQ processor, not an HTTP handler. It never accepts inbound webhooks from the blockchain — it actively polls Horizon and processes transaction streams.

```
ReconcilerProcessor (BullMQ)
  └── poll-open-payments job (cron: every 30s)
       └── For each open payment:
            1. Query Stellar Horizon for transactions on the destination account
            2. Filter by memo = payment.linkMemo
            3. Verify asset, amount, destination
            4. If match found → PaymentStateMachine.toConfirmed()
            5. Schedule finality check job (after N confirmations)
  └── finality-check job (delayed, per payment)
       └── Re-verify transaction is finalized
            → PaymentStateMachine.toCompleted()
            → Update customer aggregates
            → Enqueue webhook deliveries
```

### 12.2 Verification requirements

A transaction is considered a valid match only when ALL of the following are true:

| Check | Description |
|-------|-------------|
| `destination_address` | Matches the payment's Stellar destination address |
| `asset_code` | Matches `payment.currency` (e.g., `USDC`) |
| `asset_issuer` | Matches the known Circle USDC issuer on the target network (null only for XLM) |
| `amount` | Exact match to `payment.amount` as a decimal string |
| `memo` | Matches `payment.linkMemo` exactly |
| `transaction_hash` | Not already stored on another `Payment` (duplicate protection) |
| `ledger_close_time` | Before `payment.expiresAt` |

### 12.3 Idempotency in reconciliation

The reconciler must be idempotent:
- Before attempting a state transition, check if `payment.transactionHash` is already set.
- Use the compare-and-set pattern: `UPDATE payment SET status='confirmed', transactionHash=X WHERE id=Y AND status='pending' AND transactionHash IS NULL`.
- If the `transactionHash` is already stored for a different payment, log a critical alert (duplicate transaction — should never happen if memos are unique).

### 12.4 Failure cases

| Condition | Action |
|-----------|--------|
| Wrong asset received | `PaymentStateMachine.toFailed(failureCode='wrong_asset')` |
| Insufficient amount | `PaymentStateMachine.toFailed(failureCode='insufficient_amount')` |
| Payment already expired | `PaymentStateMachine.toExpired()` (if not already) |
| Horizon unavailable | Retry job with exponential backoff; emit `503` metric |
| Duplicate tx hash | Log critical alert; skip (do not fail payment) |

### 12.5 Customer aggregate update

After `toCompleted()`:
```typescript
await prisma.customer.update({
  where: { id: payment.customerId },
  data: {
    paymentCount: { increment: 1 },
    // lifetimeValue is USDC-denominated for v1; extend later for multi-currency
    lifetimeValue: addDecimalStrings(current.lifetimeValue, payment.amount),
    lastPaymentAt: new Date(),
  },
});
```

---

## 13. Webhook Delivery System

### 13.1 Delivery pipeline

```
PaymentStateMachine (emits event)
  → EventsService.emit()
    → WebhookDeliveryService.enqueueDeliveries(paymentEvent)
      → Query WebhookEndpoint WHERE businessId=X AND environment=Y AND events CONTAINS eventType
      → For each matching endpoint:
          CREATE WebhookDelivery { status: 'pending', nextAttemptAt: now() }
          ADD BullMQ job to 'webhook-delivery' queue
            → WebhookProcessor.process()
              → Decrypt signingSecret
              → Build payload (WebhookEventPayload)
              → Sign with HMAC-SHA256
              → POST to endpoint.url with 10s timeout
              → On success (2xx): UPDATE delivery { status: 'delivered', deliveredAt: now() }
              → On failure: schedule retry (exponential backoff)
```

### 13.2 Webhook payload structure

The payload is built from the immutable `PaymentEvent.data` snapshot, not from a live database query. This ensures the delivered payload matches exactly what was captured at event emission time.

### 13.3 Retry schedule

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |
| 5 | 1 hour |
| 6 | 6 hours |
| 7 | 24 hours |

After attempt 7, mark `WebhookDelivery.status = 'failed'`. The merchant can trigger a manual retry from the dashboard.

### 13.4 Retry conditions

Retry on: network error, timeout, HTTP `408`, `409`, `425`, `429`, `5xx`.  
Do NOT retry on: `400`–`499` (except the codes above).

### 13.5 Signing implementation

```
timestamp    = Math.floor(Date.now() / 1000)
raw_body     = JSON.stringify(payload)  // deterministic serialisation
signed_input = `${timestamp}.${raw_body}`
signature    = HMAC-SHA256(hex(signing_secret), signed_input)
header       = `t=${timestamp},v1=${signature}`
```

Headers sent:
```http
Content-Type: application/json
Hypertron-Signature: t=...,v1=...
Hypertron-Event-Id: evt_01J...
Hypertron-Delivery-Id: whd_01J...
```

### 13.6 Delivery uniqueness

The `(endpointId, eventId)` unique index on `WebhookDelivery` ensures that at most one delivery record exists per event per endpoint. The BullMQ job ID is set to `whd_${delivery.id}` to prevent duplicate job enqueuing.

### 13.7 Test webhook endpoint

`POST /api/developer/webhook-endpoints/:id/test` creates a synthetic `payment.completed`-like event and runs a single delivery attempt. The response includes the delivery status and response body. This delivery does not create a real `PaymentEvent`.

---

## 14. Idempotency System

### 14.1 Scope

Idempotency is enforced only on `POST /v1/payments`. The `Idempotency-Key` header is required for this endpoint.

### 14.2 Flow

```
1. Extract Idempotency-Key from header; reject 400 if missing/invalid.
2. Compute requestHash = SHA-256(JSON.stringify(sortedRequestBody)).
3. Query IdempotencyRecord WHERE (businessId, apiKeyId, key).
4. If found:
   a. If requestHash !== record.requestHash → 409 idempotency_error
   b. If record not yet complete (race) → 409 with Retry-After: 1
   c. Return stored responseStatus + responseBody as-is.
5. If not found:
   a. INSERT IdempotencyRecord { status: 'processing', requestHash, expiresAt: now()+24h }
   b. Execute payment creation.
   c. UPDATE record { responseStatus, responseBody, status: 'complete' }.
6. Return the created payment.
```

### 14.3 Storage

`IdempotencyRecord.responseBody` stores the serialised `Payment` JSON. The `expiresAt` field is set to `now() + 24 hours` as required by the spec. A MongoDB TTL index on `expiresAt` handles automatic cleanup.

### 14.4 Concurrency

Use MongoDB's unique index on `(businessId, apiKeyId, key)` to handle concurrent requests with the same key. The `insertOne` will fail for the second request; catch the duplicate key error and return a `409` with a `Retry-After: 1` hint while the first request is still processing.

---

## 15. Reusable Utilities & Shared Abstractions

### 15.1 ID Generator

```typescript
// common/utils/id-generator.ts
// Prefix map:
//   pay_ → Payment
//   cus_ → Customer
//   evt_ → PaymentEvent
//   key_ → ApiKey
//   we_  → WebhookEndpoint
//   whd_ → WebhookDelivery
//   req_ → Request ID
export function generateId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
```

Inject via `ID_GENERATOR` token for testability.

### 15.2 Amount utilities

```typescript
// common/utils/amount.util.ts
export function isValidDecimalString(value: string): boolean
export function comparePrecision(value: string, maxDecimals: number): boolean
export function addDecimalStrings(a: string, b: string): string  // for lifetime value
export function currencyMaxPrecision(currency: Currency): number  // USDC/EURC/XLM → 7
```

Never use `parseFloat` or `Number()` on amount values. Use string-based arithmetic only.

### 15.3 Crypto utilities

```typescript
// common/utils/crypto.util.ts
export async function hashApiKey(rawKey: string): Promise<string>    // bcrypt
export async function verifyApiKey(raw: string, hash: string): Promise<boolean>
export function generateApiKey(environment: 'test' | 'live'): string
export function generateSigningSecret(): string                       // 32-byte hex
export function encryptSecret(plaintext: string, key: Buffer): string // AES-256-GCM
export function decryptSecret(ciphertext: string, key: Buffer): string
export function signWebhookPayload(secret: string, timestamp: number, body: string): string
export function generateRequestId(): string                           // req_ + ulid
```

### 15.4 Custom decorators

| Decorator | Purpose |
|-----------|---------|
| `@CurrentMerchant()` | Extracts `{ businessId, environment, apiKeyId }` from request |
| `@CurrentUser()` | Extracts `{ userId, businessId, role }` from dashboard session |
| `@RawBody()` | Provides the raw body buffer for idempotency hashing |
| `@IdempotencyKey()` | Extracts and validates the `Idempotency-Key` header |
| `@RequestId()` | Extracts the `X-Request-Id` for the current request |

### 15.5 Exception hierarchy

```
HypertronException (base)
├── InvalidRequestException     (400)
├── AuthenticationException     (401)
├── PermissionException         (403)
├── ResourceNotFoundException   (404)
├── IdempotencyException        (409)
├── StateTransitionException    (409)
├── UnprocessableEntityException (422)
├── RateLimitException          (429)
├── ApiException                (500)
└── ServiceUnavailableException (503)
```

All exceptions carry `{ type, code, message, param?, requestId }` matching the error contract.

### 15.6 Global exception filter

`HypertronExceptionFilter` catches:
1. `HypertronException` subclasses → structured error response per spec
2. `ValidationError` from class-validator → `400 invalid_request_error` with `param` set
3. Prisma `P2002` (unique constraint) → `409 idempotency_error` or domain-specific code
4. Unknown errors → `500 api_error` with a safe generic message (no stack traces in production)

The filter always includes `request_id` in the error body.

---

## 16. Error Handling Strategy

### 16.1 Error response contract

Every error returns:

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

`param` is only present for field-level validation errors. `request_id` is always present.

### 16.2 Error type to HTTP status mapping

| Type | HTTP | When |
|------|------|------|
| `invalid_request_error` | 400 | Validation failure, bad format |
| `authentication_error` | 401 | Missing/invalid API key |
| `permission_error` | 403 | Environment mismatch, RBAC denial |
| `resource_missing` | 404 | Payment/customer not found for this merchant |
| `idempotency_error` | 409 | Key reuse with different body |
| `invalid_state_transition` | 409 | e.g., cancel a completed payment |
| `unprocessable_entity` | 422 | Unsupported asset, logic conflict |
| `rate_limit_error` | 429 | Throttle exceeded |
| `api_error` | 500 | Unexpected internal error |
| `service_unavailable` | 503 | Horizon/DB temporarily unreachable |

### 16.3 What to never include in error responses

- Stack traces
- Database error messages or codes
- Internal model names (Prisma, MongoDB collection names)
- Whether a payment ID exists in another merchant account
- Raw API key material
- Encryption keys or secret material

---

## 17. Logging, Monitoring & Tracing

### 17.1 Structured logging with Pino

Use `nestjs-pino` for structured JSON logs. Every log line must include:

| Field | Source |
|-------|--------|
| `requestId` | `X-Request-Id` header |
| `businessId` | Resolved from API key / session |
| `paymentId` | When processing a payment |
| `eventId` | When processing an event |
| `apiKeyPrefix` | For auth events (never the full key) |
| `level` | `info`, `warn`, `error` |
| `duration` | Request duration in ms |
| `statusCode` | HTTP response code |

Log levels:
- `info` — all inbound requests, payment state transitions, webhook deliveries
- `warn` — validation failures, rate limit hits, retried jobs
- `error` — unexpected exceptions, reconciliation errors, webhook permanent failures

Never log: `Authorization` header, raw API keys, signing secrets, `requestHash`.

### 17.2 Metrics

Expose a `/metrics` endpoint (Prometheus format) with these counters and histograms:

| Metric | Type | Labels |
|--------|------|--------|
| `payments_created_total` | Counter | `environment`, `currency` |
| `payments_completed_total` | Counter | `environment`, `currency` |
| `payments_failed_total` | Counter | `environment`, `failure_code` |
| `payment_completion_latency_seconds` | Histogram | `environment` |
| `reconciliation_errors_total` | Counter | `error_type` |
| `webhook_deliveries_total` | Counter | `status`, `attempt` |
| `api_requests_total` | Counter | `method`, `path`, `status` |
| `api_request_duration_seconds` | Histogram | `method`, `path` |
| `rate_limit_hits_total` | Counter | `endpoint_group` |

Use `@willsoto/nestjs-prometheus` for easy NestJS integration.

### 17.3 Distributed tracing

Use OpenTelemetry with the `@opentelemetry/auto-instrumentations-node` package, initialised in `main.ts` before the NestJS bootstrap call. This automatically instruments:
- HTTP requests (incoming and outgoing)
- MongoDB operations via Prisma
- BullMQ job processing

Propagate `traceId` into structured logs so log lines can be correlated with traces.

### 17.4 Health endpoint

```
GET /health
```

Use `@nestjs/terminus` with separate checks:

```json
{
  "status": "ok",
  "info": {
    "process": { "status": "up" },
    "database": { "status": "up" },
    "queue": { "status": "up" }
  },
  "details": {
    "stellar_testnet": { "status": "up" },
    "stellar_mainnet": { "status": "up" }
  }
}
```

The health endpoint does not require authentication. A `200` means the process is healthy. Database and blockchain checks can return `degraded` without causing a `503` — use this for liveness vs. readiness distinction in Kubernetes.

---

## 18. Rate Limiting

### 18.1 Implementation

Use `@nestjs/throttler` with Redis storage (`ThrottlerStorageRedisService`) for distributed rate limiting across multiple instances.

Define three throttler profiles:

```typescript
ThrottlerModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    throttlers: [
      { name: 'payment-create', ttl: 60_000, limit: 60 },
      { name: 'read',           ttl: 60_000, limit: 300 },
      { name: 'dashboard',      ttl: 60_000, limit: 120 },
    ],
    storage: new ThrottlerStorageRedisService(redisConnection),
  }),
});
```

Apply per-controller using `@Throttle()` decorator:
- `PaymentsController.create()` → `payment-create` (key: `apiKeyId`)
- All other `/v1` GET endpoints → `read` (key: `apiKeyId`)
- All `/api/developer` endpoints → `dashboard` (key: `userId`)

### 18.2 Rate limit response headers

When a request is throttled, return `429` with:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1785750700
```

Implement a custom `ThrottlerExceptionFilter` that maps `ThrottlerException` to the standard error shape with `type: 'rate_limit_error'`.

### 18.3 Rate limit key strategy

| Endpoint group | Rate limit key |
|----------------|----------------|
| `POST /v1/payments` | `apiKeyId` |
| `GET /v1/*` | `apiKeyId` |
| `/api/developer/*` | `userId` |

This ensures that different API keys for the same merchant are rated independently — a test key cannot exhaust a live key's quota.

---

## 19. Testing Strategy

### 19.1 Test pyramid

```
Unit tests         ──── Fast, isolated, mock all dependencies
Integration tests  ──── Test module + real DB (test MongoDB instance)
E2E tests          ──── Full HTTP stack, test containers
```

### 19.2 Unit tests

Every service and utility must have unit tests. Key areas:

- **`PaymentStateMachine`** — All valid transitions succeed; all invalid transitions throw `StateTransitionException`; terminal state transitions are rejected
- **`IdempotencyService`** — Returns cached response on replay; rejects body mismatch; handles concurrent inserts
- **`AmountUtil`** — Valid/invalid decimal strings; precision limits per currency; zero, negative, NaN, Infinity all rejected
- **`WebhookSigner`** — Signature output matches known vector; timestamp is within tolerance
- **`ApiKeyService`** — `hashApiKey` produces bcrypt output; `verifyApiKey` passes/fails correctly; `generateApiKey` produces correct prefix for environment
- **`ReconcilerService`** — All seven verification checks (asset, issuer, amount, memo, destination, expiry, duplicate hash); wrong values produce correct failure codes

### 19.3 Integration tests

Use `@nestjs/testing` with an in-memory or test MongoDB instance (MongoDB Memory Server):

- **Full payment creation flow** — `POST /v1/payments` → verify DB state, idempotency record, customer upsert, PaymentLink creation
- **Pagination** — 26 payments created; list with `limit=25` returns `has_more=true` and a valid cursor; second page returns remaining 1 with `has_more=false`
- **Lifecycle transitions** — Drive a payment from `created` → `pending` → `confirmed` → `completed`; verify each `PaymentEvent` is created; verify terminal states reject further transitions
- **Idempotency** — Same key+body returns identical response; same key+different body returns `409`
- **Environment isolation** — Live key cannot access test payments; test key cannot access live payments
- **Cross-merchant isolation** — Merchant A's payment returns `404` when fetched with Merchant B's key

### 19.4 E2E tests

Use Supertest against a running NestJS application with test containers for MongoDB and Redis:

- Full authentication flow (valid key, revoked key, test key on live payment)
- `POST /v1/payments` → `GET /v1/payments/:id` → `POST /v1/payments/:id/cancel`
- Pagination cursor stability (insertions between pages do not affect cursor results)
- Webhook signing verification (replicate the merchant-side signature check in tests)
- Rate limit enforcement (send 61 requests for `payment-create` in <60s, verify 60th succeeds and 61st returns 429)
- Health check endpoint returns expected shape

### 19.5 Reconciler tests

The reconciler is the most critical correctness surface. Test specifically:

- Matching transaction → `confirmed` → `completed`
- Wrong asset → `failed` with `failure_code=wrong_asset`
- Insufficient amount → `failed` with `failure_code=insufficient_amount`
- Expired payment → `expired` (not `failed`)
- Duplicate transaction hash → no-op (idempotent)
- Concurrent reconciler runs on the same payment → only one succeeds (compare-and-set)

### 19.6 Webhook tests

- Signature header is present and valid on every delivery
- Delivery retries follow the configured schedule
- Non-retryable status codes (404) do not trigger retries
- Retryable status codes (500) trigger retry
- `(endpointId, eventId)` uniqueness prevents duplicate deliveries

### 19.7 Coverage targets

| Layer | Target |
|-------|--------|
| Utils / state machine | 100% |
| Services | ≥ 90% |
| Controllers | ≥ 80% (covered by E2E) |
| Processors | ≥ 85% |

---

## 20. Deployment & Production Readiness

### 20.1 Docker

```dockerfile
# Multi-stage build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && npx prisma generate

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

### 20.2 Process management

- In production (Render, Railway, Fly.io), use a single process per container. BullMQ processors run in the same process.
- For horizontal scaling: scale the HTTP server containers independently from the reconciler/webhook workers. Use `DISABLE_WORKERS=true` env var to run HTTP-only containers and `DISABLE_HTTP=true` for worker-only containers.
- Set `NODE_ENV=production` to disable development-only features (Swagger UI in production is optional — gate it with an env var).

### 20.3 Graceful shutdown

NestJS's `enableShutdownHooks()` handles:
- Stop accepting new HTTP connections
- Wait for in-flight requests to complete (30s timeout)
- Close BullMQ processors (finish current job)
- Close Prisma connection
- Drain Redis connections

### 20.4 Environment-specific OpenAPI

Swagger/OpenAPI document is generated from NestJS controllers and DTOs using `@nestjs/swagger`. It is served at `/docs` in non-production environments. In production, serve it only with a `SWAGGER_ENABLED=true` flag or generate a static file for developer documentation.

### 20.5 Secret rotation

- **API keys**: When an API key is rotated (`POST /api/developer/api-keys/:id/rotate`), the old key is immediately marked `active=false`. The new key is returned once. There is no overlap period — merchants must update their integrations before rotating.
- **Webhook signing secrets**: When a signing secret is rotated, generate a new secret, store it encrypted, return it once. Existing undelivered webhooks use the old secret (stored in the delivery queue job data or re-fetched at delivery time — re-fetch approach is safer).

### 20.6 Database migrations

- Use Prisma Migrate for schema changes.
- Run `prisma migrate deploy` as part of the deployment pipeline, before the new app version starts.
- Keep migrations in version control.
- MongoDB schema changes (adding indexes) must be applied with `createIndex()` separately from Prisma migrate.

### 20.7 Monitoring and alerting

Set up alerts for:
- `api_error` rate > 1% of requests (5-minute window)
- `reconciliation_errors_total` > 0 in any 5-minute window
- `webhook_deliveries_total{status="failed"}` > 0 per hour
- P99 API response time > 2 000 ms
- MongoDB connection pool exhaustion
- Redis connection failures

### 20.8 Render/Railway deployment notes

The existing Hypertron services run on Render. Deploy `hypertron-api` as a separate Web Service:
- Build command: `pnpm install && pnpm build && npx prisma generate`
- Start command: `node dist/main.js`
- Add all required environment variables via Render's environment groups
- Use Render's private service networking to connect to MongoDB and Redis without exposing them publicly

---

## 21. Phased Implementation Roadmap

Each phase has a clear definition of done and can be merged and deployed independently.

### Phase 0 — Project scaffold (Day 1–2)

- [x] Scaffold NestJS project with pnpm and strict TypeScript
- [x] Install all dependencies
- [x] Configure Prisma with MongoDB connection
- [x] Set up `@nestjs/config` with Joi validation
- [x] Configure Pino structured logging
- [x] Implement `main.ts` with global pipes, Helmet, CORS
- [x] Implement `/health` endpoint with `@nestjs/terminus`
- [x] Set up Jest with `ts-jest`
- [x] Verify: `pnpm build` passes, health check returns 200

### Phase 1 — Data models and ID generation (Day 2–3)

- [x] Define all 7 Prisma models with full field specs and indexes
- [x] Implement `IdGenerator` with prefixed ULIDs
- [x] Implement `CryptoUtil` (key hash, HMAC, AES-GCM encrypt/decrypt)
- [x] Implement `AmountUtil` (decimal validation, precision, addition)
- [x] Run Prisma migrate/push; verify collections and indexes exist
- [x] Unit tests for all utilities (target 100% coverage)

### Phase 2 — Authentication layer (Day 3–4)

- [x] Implement `ApiKeyService.generate()` with correct prefix format
- [x] Implement `ApiKeyService.hash()` using bcrypt
- [x] Implement `ApiKeyService.verify()` with bcrypt compare
- [x] Implement `ApiKeyGuard` that extracts and verifies keys, attaches `merchant` to request
- [x] Implement `@CurrentMerchant()` decorator
- [x] Unit tests for key lifecycle; integration test for guard
- [x] Verify: authenticated request resolves merchant; invalid key returns 401

### Phase 3 — Developer API (Day 4–5)

- [x] Implement `POST /api/developer/api-keys` (session auth, Owner/Admin)
- [x] Implement `GET /api/developer/api-keys` (returns `secret_key: null`)
- [x] Implement `POST /api/developer/api-keys/:id/rotate`
- [x] Implement `POST /api/developer/api-keys/:id/revoke`
- [x] Integrate existing Privy session guard; implement `SessionGuard` and `RolesGuard`
- [x] Integration tests for all four key management routes

### Phase 4 — Payments CRUD (Day 5–8)

- [x] Implement `IdempotencyModule` with Redis-backed compare-and-set
- [x] Implement `CustomersModule` with upsert-by-email logic
- [x] Implement `EventsModule` (append-only, immutable snapshots)
- [x] Implement `PaymentStateMachine` with all seven transitions
- [x] Implement `POST /v1/payments` (full 12-step flow from spec section 7.1)
- [x] Implement `GET /v1/payments/:id`
- [x] Implement `GET /v1/payments` with cursor pagination
- [x] Implement `POST /v1/payments/:id/cancel`
- [x] Implement `GET /v1/payments/:id/events`
- [x] Integration tests for all CRUD operations, pagination, cross-merchant isolation
- [x] Verify: idempotency key replay returns identical response

### Phase 5 — Customer API (Day 8–9)

- [x] Implement `GET /v1/customers`
- [x] Implement `GET /v1/customers/:id`
- [x] Implement `GET /api/developer/customers` (dashboard)
- [x] Integration tests for customer API

### Phase 6 — Blockchain reconciliation (Day 9–12)

- [ ] Implement `StellarHorizonService` with network selection and circuit breaker
- [ ] Implement `StellarVerifier` with all seven verification checks
- [ ] Implement `ReconcilerProcessor` (BullMQ, poll-open-payments cron)
- [ ] Implement expiry checker (BullMQ cron)
- [ ] Implement customer aggregate update after completion
- [ ] Unit tests for `StellarVerifier` covering all failure cases
- [ ] Integration tests for full reconciliation flow with mocked Horizon
- [ ] Verify: concurrent reconciler runs do not double-complete a payment

### Phase 7 — Webhook system (Day 12–15)

- [ ] Implement `WebhookEndpointService` CRUD with encrypted secret storage
- [ ] Implement `WebhookSigner` with HMAC-SHA256
- [ ] Implement `WebhookDeliveryService` with BullMQ enqueuing
- [ ] Implement `WebhookProcessor` with retry schedule
- [ ] Implement delivery observability routes (`GET /api/developer/webhook-endpoints/:id/deliveries`)
- [ ] Implement test webhook endpoint (`POST /api/developer/webhook-endpoints/:id/test`)
- [ ] Unit tests for signing; integration tests for delivery + retry; signature verification tests

### Phase 8 — Observability & hardening (Day 15–17)

- [ ] Add Prometheus metrics for all key counters and histograms
- [ ] Integrate OpenTelemetry tracing
- [ ] Add `X-Request-Id` to all responses
- [ ] Add structured rate limit response headers
- [ ] Implement `HypertronExceptionFilter` for all error types
- [ ] Implement `ThrottlerExceptionFilter` with rate limit headers
- [ ] Review all log statements; remove any that could leak secrets

### Phase 9 — OpenAPI & documentation (Day 17–18)

- [ ] Add `@ApiProperty()` decorators to all DTOs
- [ ] Add `@ApiOperation()`, `@ApiResponse()` to all controllers
- [ ] Generate and commit `openapi.yaml`
- [ ] Verify generated spec matches `Payments_API_v1_Schema.md`

### Phase 10 — E2E tests, review, and production readiness (Day 18–21)

- [ ] Write full E2E test suite covering all lifecycle transitions, auth, pagination, rate limits, webhook signing
- [ ] Security review: no secrets in logs, no cross-merchant leaks
- [ ] Load test: verify rate limits enforce at the correct thresholds
- [ ] Docker build and health check in container
- [ ] Deploy to staging on Render; run E2E tests against staging
- [ ] Configure alerts and dashboards
- [ ] Production deployment

---

## 22. Additional Recommendations

### 22.1 Memo uniqueness strategy

The `linkMemo` (`hpl_*`) is the Stellar attribution mechanism. It must be globally unique and collision-resistant. Recommended format:

```
hpl_<base58(sha256(paymentId)[0:8])>
```

Since `paymentId` is a prefixed ULID (guaranteed unique), this produces a short, deterministic, collision-free memo that fits within Stellar's 28-byte memo text limit.

### 22.2 Amount precision handling

Never use JavaScript `number` for amounts. Use the `Decimal.js` or `big.js` library for any arithmetic. The `AmountUtil.addDecimalStrings()` for customer lifetime value aggregation must use string-safe integer arithmetic.

### 22.3 Multi-currency lifetime value

The spec acknowledges that `lifetimeValue` per currency is complex. For v1, store it as a single USDC-denominated string and document that XLM and EURC payments are tracked separately in a later iteration. The `Customer.lifetimeValueCurrency` field signals which currency the aggregated value is in.

### 22.4 Preventing double-completion

The reconciler's compare-and-set approach (`UPDATE WHERE status = 'pending' AND transactionHash IS NULL`) combined with the unique index on `Payment.transactionHash` provides two independent safeguards against double-completion. Both must be present.

### 22.5 Webhook secret envelope encryption

For the webhook signing secret:

1. Generate a random 32-byte data key per webhook endpoint.
2. Encrypt the signing secret with this data key (AES-256-GCM).
3. Encrypt the data key with the master `WEBHOOK_SECRET_ENCRYPTION_KEY`.
4. Store both the encrypted data key and the ciphertext.

This allows the master key to be rotated without re-encrypting all webhook secrets — only the data key envelopes need re-encryption.

### 22.6 Stellar destination key management

The `destinationAddress` on each payment is the Hypertron receiving address for the environment. For v1, this is a single address per environment. In a later version, generate per-payment addresses to eliminate the dependency on the memo for attribution. The memo-based approach is simpler and sufficient for v1.

Store the destination keypair securely:
- Private keys only in environment secrets (never in the codebase)
- Consider a KMS-backed HSM for production key signing
- The gateway never signs Stellar transactions — it only reads from Horizon

### 22.7 Test vs. live key enforcement

The environment field must be enforced at three layers:
1. **API key guard**: Reads `ApiKey.environment` and stores it in the request context
2. **Repository layer**: All queries include `environment` as a filter predicate
3. **State machine**: Validates that the API key environment matches the payment environment before any transition

If any layer is missing, a test key could accidentally read or modify live payments.

### 22.8 OpenAPI generation

Generate the `openapi.yaml` from the NestJS app using `SwaggerModule.createDocument()`. Add a CI step that generates the spec and fails if it differs from the committed version (`git diff --exit-code openapi.yaml`). This ensures the spec is always in sync with the implementation.

### 22.9 Future capabilities to design for now

These are out of scope for v1 but should be anticipated in the schema and architecture:
- **Refunds** — the `Payment` schema has no `refund_id`; add a nullable `refundId` field now so the column exists when needed
- **Publishable keys** (`pk_test_*` / `pk_live_*`) — the `ApiKey.environment` enum and prefix are already designed to support them
- **Quote resource** for fiat pricing — the separation of `currency` (asset) from fiat display currency is already correct
- **Per-payment destination addresses** — the `destinationAddress` is already a per-payment field, not a global setting
- **Standalone customer create/update API** — `CustomersModule` is already isolated and can accept new routes

### 22.10 Relation to existing backend

The existing `backend/src/index.js` is a throwaway proof-of-concept. The `hypertron-api` NestJS service is the replacement. The existing `ai-analyzer` service and its routes are unrelated and should continue running independently. The two services share the same MongoDB database but use separate collections. Coordinate on Prisma schema migrations to avoid conflicts.

---

*Document version: 1.0 — Generated from `Payments_API_v1_Schema.md` on 2026-08-04*
