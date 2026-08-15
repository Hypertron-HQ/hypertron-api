/**
 * Integration tests — /v1/payments (Phase 4)
 *
 * Runs the full NestJS PaymentsModule with an in-memory mock for PrismaService.
 * No live DB or Redis required.
 *
 * Routes tested:
 *   POST /v1/payments              — create (idempotency, validation, lifecycle)
 *   GET  /v1/payments/:id          — retrieve single payment
 *   GET  /v1/payments              — list with cursor pagination
 *   POST /v1/payments/:id/cancel   — cancel (state machine)
 *   GET  /v1/payments/:id/events   — list events
 *
 * Scenarios:
 *   - Valid creation → 201, status=pending, secret_key absent
 *   - Idempotency replay → identical 201 response
 *   - Idempotency body mismatch → 409
 *   - Idempotency in-flight → 409
 *   - Idempotency concurrent reserve race → 409
 *   - Missing / invalid Idempotency-Key → 400
 *   - Invalid amount → 400
 *   - Retrieve existing payment → 200
 *   - Retrieve non-existent → 404
 *   - Cross-environment isolation (test key cannot see live payments)
 *   - Cross-merchant isolation (business A cannot see business B)
 *   - List with has_more and cursor pagination
 *   - Cancel created/pending payment → 200
 *   - Cancel completed payment → 409
 *   - List events → 200
 */

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as crypto from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type {
  Payment,
  PaymentEvent,
  Customer,
  IdempotencyRecord,
} from '@prisma/client';
import { PaymentStatus } from '@prisma/client';

import securityConfig from '@/common/config/security.config';
import appConfig from '@/common/config/app.config';
import stellarConfig from '@/common/config/stellar.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { generateApiKey, hashApiKey } from '@/common/utils/crypto.util';
import type { ApiKey } from '@prisma/client';

// ─── In-memory store ──────────────────────────────────────────────────────────

class InMemoryStore {
  payments: Payment[] = [];
  events: PaymentEvent[] = [];
  customers: Customer[] = [];
  apiKeys: ApiKey[] = [];
  idempotency: IdempotencyRecord[] = [];
  merchantSettings: {
    id: string;
    businessId: string;
    walletAddress: string;
    receiveAddress: string | null;
  }[] = [];
  checkoutLinks: {
    id: string;
    publicId: string;
    businessId: string;
    environment: string;
    amount: string;
    currency: string;
    description: string | null;
    linkMemo: string;
    destinationAddress: string;
    expiresAt: Date | null;
    paidAt: Date | null;
    paymentTxHash: string | null;
    createdAt: Date;
  }[] = [];

  private nextId = 0;
  genId() {
    return `oid_${++this.nextId}`;
  }
}

class MockPrismaService {
  readonly store = new InMemoryStore();

  readonly payment = {
    create: jest.fn(async ({ data }: { data: Partial<Payment> }) => {
      const p: Payment = {
        id: this.store.genId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: PaymentStatus.created,
        payerAddress: null,
        transactionHash: null,
        assetIssuer: null,
        failureCode: null,
        failureMessage: null,
        paidAt: null,
        completedAt: null,
        canceledAt: null,
        expiresAt: null,
        customerId: null,
        description: null,
        metadata: {},
        ...data,
      } as Payment;
      this.store.payments.push(p);
      return p;
    }),
    findFirst: jest.fn(
      async ({ where }: { where: Partial<Payment> }) =>
        this.store.payments.find((p) =>
          Object.entries(where).every(
            ([k, v]) => (p as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { id?: string; publicId?: string } }) =>
        this.store.payments.find(
          (p) =>
            (where.id ? p.id === where.id : true) &&
            (where.publicId ? p.publicId === where.publicId : true),
        ) ?? null,
    ),
    findMany: jest.fn(
      async ({
        where,
        take,
      }: {
        where?: Partial<Payment> & {
          OR?: Array<Record<string, unknown>>;
          environment?: string;
        };
        take?: number;
        orderBy?: object[];
      }) => {
        let results = this.store.payments.filter((p) => {
          if (where?.businessId && p.businessId !== where.businessId)
            return false;
          if (where?.environment && p.environment !== where.environment)
            return false;
          if (where?.OR?.length) {
            return where.OR.some((clause) => {
              const createdAt = clause.createdAt as
                Date | { lt?: Date } | undefined;
              if (
                createdAt &&
                typeof createdAt === 'object' &&
                !(createdAt instanceof Date) &&
                createdAt.lt
              ) {
                return p.createdAt.getTime() < createdAt.lt.getTime();
              }
              if (createdAt instanceof Date && typeof clause.id === 'object') {
                const idClause = clause.id as { lt?: string };
                return (
                  p.createdAt.getTime() === createdAt.getTime() &&
                  !!idClause.lt &&
                  p.id < idClause.lt
                );
              }
              return false;
            });
          }
          return true;
        });
        results = results.slice().sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          if (byTime !== 0) return byTime;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });
        if (take) results = results.slice(0, take);
        return results;
      },
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status?: { in: PaymentStatus[] } };
        data: Partial<Payment>;
      }) => {
        const p = this.store.payments.find((x) => x.id === where.id);
        if (!p) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(p.status))
          return { count: 0 };
        Object.assign(p, data);
        p.updatedAt = new Date();
        return { count: 1 };
      },
    ),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Payment>;
      }) => {
        const p = this.store.payments.find((x) => x.id === where.id);
        if (p) Object.assign(p, data);
        return p!;
      },
    ),
  };

  readonly paymentEvent = {
    create: jest.fn(async ({ data }: { data: Partial<PaymentEvent> }) => {
      const evt: PaymentEvent = {
        id: this.store.genId(),
        createdAt: new Date(),
        ...data,
      } as PaymentEvent;
      this.store.events.push(evt);
      return evt;
    }),
    findMany: jest.fn(
      async ({
        where,
      }: {
        where: { paymentId?: string; businessId?: string };
      }) =>
        this.store.events.filter((e) => {
          if (where.paymentId && e.paymentId !== where.paymentId) return false;
          if (where.businessId && e.businessId !== where.businessId)
            return false;
          return true;
        }),
    ),
  };

  readonly customer = {
    findFirst: jest.fn(
      async ({ where }: { where: Partial<Customer> }) =>
        this.store.customers.find((c) =>
          Object.entries(where).every(
            ([k, v]) => (c as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Partial<Customer> }) => {
      const c: Customer = {
        id: this.store.genId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        paymentCount: 0,
        lifetimeValue: '0.00',
        lifetimeValueCurrency: 'USDC',
        lastPaymentAt: null,
        email: null,
        name: null,
        metadata: {},
        ...data,
      } as Customer;
      this.store.customers.push(c);
      return c;
    }),
    update: jest.fn(),
  };

  readonly apiKey = {
    findMany: jest.fn(async ({ where }: { where: Partial<ApiKey> }) =>
      this.store.apiKeys.filter((k) =>
        Object.entries(where).every(
          ([f, v]) => (k as Record<string, unknown>)[f] === v,
        ),
      ),
    ),
    findFirst: jest.fn(
      async ({ where }: { where: Partial<ApiKey> }) =>
        this.store.apiKeys.find((k) =>
          Object.entries(where).every(
            ([f, v]) => (k as Record<string, unknown>)[f] === v,
          ),
        ) ?? null,
    ),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ApiKey>;
      }) => {
        const k = this.store.apiKeys.find((x) => x.id === where.id);
        if (k) Object.assign(k, data);
        return k!;
      },
    ),
    create: jest.fn(async ({ data }: { data: Partial<ApiKey> }) => {
      const k: ApiKey = {
        id: this.store.genId(),
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
        active: true,
        ...data,
      } as ApiKey;
      this.store.apiKeys.push(k);
      return k;
    }),
  };

  readonly idempotencyRecord = {
    findFirst: jest.fn(
      async ({ where }: { where: Partial<IdempotencyRecord> }) =>
        this.store.idempotency.find((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Partial<IdempotencyRecord> }) => {
      const existing = this.store.idempotency.find(
        (r) =>
          r.businessId === data.businessId &&
          r.apiKeyId === data.apiKeyId &&
          r.key === data.key,
      );
      if (existing) {
        const err: { code: string } = { code: 'P2002' };
        throw err;
      }
      const r: IdempotencyRecord = {
        id: this.store.genId(),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        ...data,
      } as IdempotencyRecord;
      this.store.idempotency.push(r);
      return r;
    }),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Partial<IdempotencyRecord>;
        data: Partial<IdempotencyRecord>;
      }) => {
        const r = this.store.idempotency.find(
          (x) =>
            x.businessId === where.businessId &&
            x.apiKeyId === where.apiKeyId &&
            x.key === where.key,
        );
        if (r) Object.assign(r, data);
        return { count: r ? 1 : 0 };
      },
    ),
  };

  readonly merchantSettings = {
    findUnique: jest.fn(
      async ({
        where,
        select,
      }: {
        where: { businessId?: string; walletAddress?: string };
        select?: { receiveAddress?: boolean; businessId?: boolean };
      }) => {
        const row = this.store.merchantSettings.find((b) =>
          where.businessId
            ? b.businessId === where.businessId
            : b.walletAddress === where.walletAddress,
        );
        if (!row) return null;
        if (select?.receiveAddress) {
          return { receiveAddress: row.receiveAddress };
        }
        return row;
      },
    ),
  };

  readonly checkoutLink = {
    findUnique: jest.fn(
      async ({
        where,
        select,
      }: {
        where: { linkMemo?: string; id?: string; publicId?: string };
        select?: { id?: boolean };
      }) => {
        const row = this.store.checkoutLinks.find((l) => {
          if (where.linkMemo) return l.linkMemo === where.linkMemo;
          if (where.publicId) return l.publicId === where.publicId;
          return l.id === where.id;
        });
        if (!row) return null;
        return select?.id ? { id: row.id } : row;
      },
    ),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const link = {
        id: `cloid_${this.store.genId()}`,
        createdAt: new Date(),
        description: null,
        expiresAt: null,
        paidAt: null,
        paymentTxHash: null,
        ...data,
      } as InMemoryStore['checkoutLinks'][number];
      this.store.checkoutLinks.push(link);
      return link;
    }),
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<unknown>[]) {
    return Promise.all(ops);
  }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

const BIZ_ID = 'biz_pay_test_001';
const BIZ_B = 'biz_pay_test_002';
const API_KEY_PUBLIC_ID = 'key_pay_test_001';

/** Mirrors IdempotencyService.hashBody — used to seed in-flight records. */
function hashBody(body: Record<string, unknown>): string {
  const sorted = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(sorted, 'utf8').digest('hex');
}

async function seedApiKey(
  prisma: MockPrismaService,
  opts: {
    env?: 'test' | 'live';
    businessId?: string;
    publicId?: string;
  } = {},
) {
  const env = opts.env ?? 'test';
  const businessId = opts.businessId ?? BIZ_ID;
  const publicId = opts.publicId ?? `key_${env}_${businessId}`;
  const rawKey = generateApiKey(env);
  const hash = await hashApiKey(rawKey, 4);
  prisma.store.apiKeys.push({
    id: `apikeyid_${publicId}`,
    publicId,
    businessId,
    name: `${env} key`,
    environment: env,
    keyPrefix: `sk_${env}_`,
    secretHash: hash,
    lastFour: rawKey.slice(-4),
    active: true,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  });
  return { rawKey, publicId, businessId, env };
}

function seedPayment(
  prisma: MockPrismaService,
  overrides: Partial<Payment> = {},
): Payment {
  const now = new Date();
  const p: Payment = {
    id: prisma.store.genId(),
    publicId:
      overrides.publicId ?? `pay_seed_${prisma.store.payments.length + 1}`,
    businessId: overrides.businessId ?? BIZ_ID,
    environment: overrides.environment ?? 'test',
    amount: overrides.amount ?? '10.00',
    currency: overrides.currency ?? 'USDC',
    status: overrides.status ?? PaymentStatus.pending,
    description: overrides.description ?? null,
    customerId: overrides.customerId ?? null,
    metadata: overrides.metadata ?? {},
    checkoutUrl: overrides.checkoutUrl ?? 'http://localhost/checkout',
    checkoutLinkId: overrides.checkoutLinkId ?? 'cloid_seed',
    linkMemo: overrides.linkMemo ?? 'hpl_seed',
    destinationAddress: overrides.destinationAddress ?? 'GDEST',
    payerAddress: null,
    transactionHash: null,
    assetIssuer: null,
    failureCode: null,
    failureMessage: null,
    paidAt: null,
    completedAt: null,
    canceledAt: null,
    expiresAt: null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  prisma.store.payments.push(p);
  return p;
}

// ─── Test module ──────────────────────────────────────────────────────────────

describe('/v1/payments (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;
  let rawKey: string;
  let apiKeyPublicId: string;
  const IDEM_KEY = 'test-idem-key-001';

  const VALID_BODY = {
    amount: '10.50',
    currency: 'USDC',
    description: 'Test payment',
    customer_email: 'alice@example.com',
  };

  beforeEach(async () => {
    prisma = new MockPrismaService();
    prisma.store.merchantSettings.push({
      id: 'ms_1',
      businessId: BIZ_ID,
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      // Classic G… destination (56 chars) — never pool C…
      receiveAddress:
        'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    });
    const seeded = await seedApiKey(prisma, {
      env: 'test',
      businessId: BIZ_ID,
      publicId: API_KEY_PUBLIC_ID,
    });
    rawKey = seeded.rawKey;
    apiKeyPublicId = seeded.publicId;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig, appConfig, stellarConfig],
          ignoreEnvFile: true,
        }),
        PaymentsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${rawKey}` });

  // ─── POST /v1/payments ─────────────────────────────────────────────────────

  describe('POST /v1/payments', () => {
    it('201 — creates payment with status=pending', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', IDEM_KEY)
        .send(VALID_BODY)
        .expect(201);

      expect(res.body.object).toBe('payment');
      expect(res.body.id).toMatch(/^pay_/);
      expect(res.body.status).toBe('pending');
      expect(res.body.amount).toBe('10.50');
      expect(res.body.currency).toBe('USDC');
      expect(res.body.checkout_url).toMatch(/^http.*\/pay\/cl_/);
      expect(res.body.link_memo).toMatch(/^hpl_/);
      // API-created links are never private settlement
      expect(prisma.store.checkoutLinks).toHaveLength(1);
      const link = prisma.store.checkoutLinks[0] as Record<string, unknown>;
      expect(link.metadata).toBeUndefined();
      expect(link.shieldSalt).toBeUndefined();
      expect(link.shieldCommitment).toBeUndefined();
      expect(link.shieldProof).toBeUndefined();
      expect(link).not.toHaveProperty('privateSettlement');
    });

    it('201 — dto.metadata stays on Payment only; CheckoutLink stays non-private', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-meta-private-flag')
        .send({
          ...VALID_BODY,
          metadata: { privateSettlement: true, note: 'must not hit link' },
        })
        .expect(201);

      const payment = prisma.store.payments.find(
        (p) => p.publicId === res.body.id,
      );
      expect(payment?.metadata).toMatchObject({ privateSettlement: true });

      const link = prisma.store.checkoutLinks.find(
        (l) => l.id === payment?.checkoutLinkId,
      );
      expect(link).toBeTruthy();
      expect(link as { metadata?: unknown }).not.toHaveProperty('metadata');
      expect(link as { shieldCommitment?: unknown }).not.toHaveProperty(
        'shieldCommitment',
      );
    });

    it('201 — idempotency replay returns identical response', async () => {
      const r1 = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', IDEM_KEY)
        .send(VALID_BODY)
        .expect(201);

      const r2 = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', IDEM_KEY)
        .send(VALID_BODY)
        .expect(201);

      expect(r2.body.id).toBe(r1.body.id);
      expect(r2.body.status).toBe(r1.body.status);
    });

    it('409 — idempotency body mismatch (same key, different body)', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-mismatch')
        .send(VALID_BODY)
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-mismatch')
        .send({ ...VALID_BODY, amount: '99.00' })
        .expect(409);

      expect(res.body.error.type).toBe('idempotency_error');
      expect(res.body.error.code).toBe('idempotency_key_reused');
    });

    it('409 — idempotency key still in-flight', async () => {
      // Seed an in-flight record matching VALID_BODY hash (responseStatus=0)
      prisma.store.idempotency.push({
        id: prisma.store.genId(),
        businessId: BIZ_ID,
        apiKeyId: apiKeyPublicId,
        key: 'idem-inflight',
        requestHash: hashBody(VALID_BODY),
        responseStatus: 0,
        responseBody: {},
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-inflight')
        .send(VALID_BODY)
        .expect(409);

      expect(res.body.error.type).toBe('idempotency_error');
      expect(res.body.error.code).toBe('idempotency_key_in_flight');
    });

    it('409 — concurrent reserve race returns in-flight', async () => {
      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post('/v1/payments')
          .set(auth())
          .set('Idempotency-Key', 'idem-race')
          .send(VALID_BODY),
        request(app.getHttpServer())
          .post('/v1/payments')
          .set(auth())
          .set('Idempotency-Key', 'idem-race')
          .send(VALID_BODY),
      ]);

      // Guarantees: at most one payment; loser is 409 in-flight OR both 201 replay same id
      expect([r1.status, r2.status].every((s) => s === 201 || s === 409)).toBe(
        true,
      );
      expect([r1.status, r2.status].includes(201)).toBe(true);
      expect(
        prisma.store.payments.filter((p) => p.businessId === BIZ_ID),
      ).toHaveLength(1);

      if (r1.status === 201 && r2.status === 201) {
        expect(r1.body.id).toBe(r2.body.id);
      } else {
        const conflict = r1.status === 409 ? r1 : r2;
        expect(conflict.body.error.type).toBe('idempotency_error');
        expect(conflict.body.error.code).toBe('idempotency_key_in_flight');
      }
    });

    it('400 — missing Idempotency-Key header', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .send(VALID_BODY)
        .expect(400);

      expect(res.body.error.code).toBe('missing_idempotency_key');
    });

    it('400 — Idempotency-Key longer than 255 chars', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'x'.repeat(256))
        .send(VALID_BODY)
        .expect(400);

      expect(res.body.error.code).toBe('invalid_idempotency_key');
    });

    it('400 — invalid amount (zero)', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-zero')
        .send({ ...VALID_BODY, amount: '0' })
        .expect(400);
    });

    it('400 — invalid amount (negative)', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-neg')
        .send({ ...VALID_BODY, amount: '-5' })
        .expect(400);
    });

    it('400 — invalid amount (too many decimals)', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-prec')
        .send({ ...VALID_BODY, amount: '1.12345678' })
        .expect(400);
    });

    it('400 — unsupported currency', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-curr')
        .send({ ...VALID_BODY, currency: 'BTC' })
        .expect(400);
    });

    it('401 — missing auth header', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('Idempotency-Key', IDEM_KEY)
        .send(VALID_BODY)
        .expect(401);
    });

    it('does not return secretHash or internal fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', IDEM_KEY)
        .send(VALID_BODY)
        .expect(201);

      expect(res.body).not.toHaveProperty('secretHash');
      expect(res.body).not.toHaveProperty('_id');
      expect(res.body).not.toHaveProperty('id', expect.stringMatching(/^oid_/)); // internal mongo id
    });
  });

  // ─── GET /v1/payments/:id ──────────────────────────────────────────────────

  describe('GET /v1/payments/:id', () => {
    it('200 — returns the payment', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-get-1')
        .send(VALID_BODY)
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/payments/${created.body.id}`)
        .set(auth())
        .expect(200);

      expect(res.body.id).toBe(created.body.id);
      expect(res.body.status).toBe('pending');
    });

    it('404 — payment not found', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/payments/pay_doesnotexist')
        .set(auth())
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — cross-environment isolation (test key cannot see live payment)', async () => {
      const live = seedPayment(prisma, {
        publicId: 'pay_live_only',
        environment: 'live',
        businessId: BIZ_ID,
      });

      const res = await request(app.getHttpServer())
        .get(`/v1/payments/${live.publicId}`)
        .set(auth()) // test-env key
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — live key cannot read or cancel a test payment', async () => {
      const testPay = seedPayment(prisma, {
        publicId: 'pay_test_for_live_key',
        environment: 'test',
        businessId: BIZ_ID,
        status: PaymentStatus.pending,
      });
      const liveSeeded = await seedApiKey(prisma, {
        env: 'live',
        businessId: BIZ_ID,
        publicId: 'key_live_iso',
      });
      const liveAuth = {
        Authorization: `Bearer ${liveSeeded.rawKey}`,
      };

      await request(app.getHttpServer())
        .get(`/v1/payments/${testPay.publicId}`)
        .set(liveAuth)
        .expect(404);

      await request(app.getHttpServer())
        .post(`/v1/payments/${testPay.publicId}/cancel`)
        .set(liveAuth)
        .expect(404);

      // Still pending — live key must not mutate
      expect(
        prisma.store.payments.find((p) => p.publicId === testPay.publicId)
          ?.status,
      ).toBe(PaymentStatus.pending);
    });

    it('200 — live key list excludes test payments', async () => {
      seedPayment(prisma, {
        publicId: 'pay_test_hidden_from_live',
        environment: 'test',
        businessId: BIZ_ID,
      });
      seedPayment(prisma, {
        publicId: 'pay_live_visible',
        environment: 'live',
        businessId: BIZ_ID,
      });
      const liveSeeded = await seedApiKey(prisma, {
        env: 'live',
        businessId: BIZ_ID,
        publicId: 'key_live_list',
      });

      const res = await request(app.getHttpServer())
        .get('/v1/payments')
        .set({ Authorization: `Bearer ${liveSeeded.rawKey}` })
        .expect(200);

      const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toContain('pay_live_visible');
      expect(ids).not.toContain('pay_test_hidden_from_live');
    });

    it('404 — cross-merchant isolation (BIZ_A cannot see BIZ_B payment)', async () => {
      const other = seedPayment(prisma, {
        publicId: 'pay_other_biz',
        businessId: BIZ_B,
        environment: 'test',
      });

      const res = await request(app.getHttpServer())
        .get(`/v1/payments/${other.publicId}`)
        .set(auth())
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('401 — missing auth', async () => {
      await request(app.getHttpServer()).get('/v1/payments/pay_1').expect(401);
    });
  });

  // ─── GET /v1/payments ─────────────────────────────────────────────────────

  describe('GET /v1/payments', () => {
    it('200 — returns list envelope with object=list', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/payments')
        .set(auth())
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(typeof res.body.has_more).toBe('boolean');
      expect(res.body).toHaveProperty('next_cursor');
    });

    it('200 — lists created payments', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'list-1')
        .send(VALID_BODY);
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'list-2')
        .send({ ...VALID_BODY, amount: '5.00' });

      const res = await request(app.getHttpServer())
        .get('/v1/payments')
        .set(auth())
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('200 — has_more=true and cursor returns remaining page', async () => {
      // Create 3 payments so limit=2 yields has_more + a second page
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/v1/payments')
          .set(auth())
          .set('Idempotency-Key', `page-${i}`)
          .send({ ...VALID_BODY, amount: `${(i + 1).toFixed(2)}` })
          .expect(201);
      }

      const page1 = await request(app.getHttpServer())
        .get('/v1/payments?limit=2')
        .set(auth())
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.next_cursor).toEqual(expect.any(String));

      const page2 = await request(app.getHttpServer())
        .get(
          `/v1/payments?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
        )
        .set(auth())
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.has_more).toBe(false);
      expect(page2.body.next_cursor).toBeNull();

      const page1Ids = page1.body.data.map((p: { id: string }) => p.id);
      const page2Ids = page2.body.data.map((p: { id: string }) => p.id);
      expect(page1Ids).not.toEqual(expect.arrayContaining(page2Ids));
    });

    it('200 — list excludes other-environment and other-business payments', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'list-own')
        .send(VALID_BODY)
        .expect(201);

      seedPayment(prisma, {
        publicId: 'pay_live_hidden',
        environment: 'live',
        businessId: BIZ_ID,
      });
      seedPayment(prisma, {
        publicId: 'pay_other_hidden',
        environment: 'test',
        businessId: BIZ_B,
      });

      const res = await request(app.getHttpServer())
        .get('/v1/payments')
        .set(auth())
        .expect(200);

      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids).not.toContain('pay_live_hidden');
      expect(ids).not.toContain('pay_other_hidden');
      expect(ids.length).toBeGreaterThanOrEqual(1);
    });

    it('400 — limit > 100 is rejected', async () => {
      await request(app.getHttpServer())
        .get('/v1/payments?limit=101')
        .set(auth())
        .expect(400);
    });

    it('200 — has_more=false when fewer results than limit', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/payments?limit=100')
        .set(auth())
        .expect(200);

      expect(res.body.has_more).toBe(false);
      expect(res.body.next_cursor).toBeNull();
    });
  });

  // ─── POST /v1/payments/:id/cancel ─────────────────────────────────────────

  describe('POST /v1/payments/:id/cancel', () => {
    it('200 — cancels a pending payment', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-cancel-1')
        .send(VALID_BODY)
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/v1/payments/${created.body.id}/cancel`)
        .set(auth())
        .expect(200);

      expect(res.body.status).toBe('canceled');
      expect(res.body.canceled_at).not.toBeNull();
    });

    it('404 — cancel non-existent payment', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments/pay_ghost/cancel')
        .set(auth())
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('409 — cannot cancel a completed payment', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-cancel-comp')
        .send(VALID_BODY)
        .expect(201);

      // Force the payment to completed state in the store
      const p = prisma.store.payments.find(
        (x) => x.publicId === created.body.id,
      );
      if (p) p.status = PaymentStatus.completed;

      const res = await request(app.getHttpServer())
        .post(`/v1/payments/${created.body.id}/cancel`)
        .set(auth())
        .expect(409);

      expect(res.body.error.type).toBe('invalid_state_transition');
    });
  });

  // ─── GET /v1/payments/:id/events ──────────────────────────────────────────

  describe('GET /v1/payments/:id/events', () => {
    it('200 — returns events list for a payment', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .set('Idempotency-Key', 'idem-events-1')
        .send(VALID_BODY)
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/payments/${created.body.id}/events`)
        .set(auth())
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      // Should have at least payment.created + payment.pending
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0]).toHaveProperty('type');
      expect(res.body.data[0]).toHaveProperty('id');
      expect(res.body.data[0].object).toBe('payment_event');
    });

    it('404 — events for non-existent payment', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/payments/pay_ghost/events')
        .set(auth())
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });
  });
});
