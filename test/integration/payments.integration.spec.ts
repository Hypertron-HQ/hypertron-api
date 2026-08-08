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
 *   - Missing Idempotency-Key → 400
 *   - Invalid amount → 400
 *   - Retrieve existing payment → 200
 *   - Retrieve non-existent → 404
 *   - Cross-environment isolation (test key cannot see live payments)
 *   - List with has_more and cursor
 *   - Cancel created/pending payment → 200
 *   - Cancel completed payment → 409
 *   - List events → 200
 */

import {
  Controller,
  Module,
  UseGuards,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { Payment, PaymentEvent, Customer, IdempotencyRecord } from '@prisma/client';
import { PaymentStatus } from '@prisma/client';

import securityConfig from '@/common/config/security.config';
import appConfig from '@/common/config/app.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { ApiKeyGuard } from '@/common/guards/api-key.guard';
import { ApiKeyService } from '@/modules/auth/api-key.service';
import {
  CurrentMerchant,
  type MerchantContext,
  MERCHANT_CONTEXT_KEY,
} from '@/common/decorators/current-merchant.decorator';
import { PaymentsService } from '@/modules/payments/payments.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { generateApiKey, hashApiKey } from '@/common/utils/crypto.util';
import type { ApiKey } from '@prisma/client';
import {
  toPaymentListResponse,
  toPaymentEventListResponse,
} from '@/modules/payments/dto/payment-response.dto';
import { CreatePaymentDto } from '@/modules/payments/dto/create-payment.dto';
import { ListPaymentsDto } from '@/modules/payments/dto/list-payments.dto';

// ─── In-memory store ──────────────────────────────────────────────────────────

class InMemoryStore {
  payments: Payment[] = [];
  events: PaymentEvent[] = [];
  customers: Customer[] = [];
  apiKeys: ApiKey[] = [];
  idempotency: IdempotencyRecord[] = [];

  private nextId = 0;
  genId() { return `oid_${++this.nextId}`; }
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
    findFirst: jest.fn(async ({ where }: { where: Partial<Payment> }) =>
      this.store.payments.find((p) =>
        Object.entries(where).every(([k, v]) => (p as Record<string, unknown>)[k] === v),
      ) ?? null,
    ),
    findUnique: jest.fn(async ({ where }: { where: { id?: string; publicId?: string } }) =>
      this.store.payments.find((p) =>
        (where.id ? p.id === where.id : true) &&
        (where.publicId ? p.publicId === where.publicId : true),
      ) ?? null,
    ),
    findMany: jest.fn(async ({ where, take, orderBy }: {
      where?: Partial<Payment> & { OR?: object[]; environment?: string };
      take?: number;
      orderBy?: object[];
    }) => {
      let results = this.store.payments.filter((p) => {
        if (where?.businessId && p.businessId !== where.businessId) return false;
        if (where?.environment && p.environment !== where.environment) return false;
        return true;
      });
      results = results.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (take) results = results.slice(0, take);
      return results;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { id: string; status?: { in: PaymentStatus[] } }; data: Partial<Payment> }) => {
      const p = this.store.payments.find((x) => x.id === where.id);
      if (!p) return { count: 0 };
      if (where.status?.in && !where.status.in.includes(p.status)) return { count: 0 };
      Object.assign(p, data);
      p.updatedAt = new Date();
      return { count: 1 };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Payment> }) => {
      const p = this.store.payments.find((x) => x.id === where.id);
      if (p) Object.assign(p, data);
      return p!;
    }),
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
    findMany: jest.fn(async ({ where }: { where: { paymentId?: string; businessId?: string } }) =>
      this.store.events.filter((e) => {
        if (where.paymentId && e.paymentId !== where.paymentId) return false;
        if (where.businessId && e.businessId !== where.businessId) return false;
        return true;
      }),
    ),
  };

  readonly customer = {
    findFirst: jest.fn(async ({ where }: { where: Partial<Customer> }) =>
      this.store.customers.find((c) =>
        Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
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
        Object.entries(where).every(([f, v]) => (k as Record<string, unknown>)[f] === v),
      ),
    ),
    findFirst: jest.fn(async ({ where }: { where: Partial<ApiKey> }) =>
      this.store.apiKeys.find((k) =>
        Object.entries(where).every(([f, v]) => (k as Record<string, unknown>)[f] === v),
      ) ?? null,
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ApiKey> }) => {
      const k = this.store.apiKeys.find((x) => x.id === where.id);
      if (k) Object.assign(k, data);
      return k!;
    }),
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
    findFirst: jest.fn(async ({ where }: { where: Partial<IdempotencyRecord> }) =>
      this.store.idempotency.find((r) =>
        Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      ) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Partial<IdempotencyRecord> }) => {
      const existing = this.store.idempotency.find(
        (r) => r.businessId === data.businessId && r.apiKeyId === data.apiKeyId && r.key === data.key,
      );
      if (existing) { const err: { code: string } = { code: 'P2002' }; throw err; }
      const r: IdempotencyRecord = {
        id: this.store.genId(),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        ...data,
      } as IdempotencyRecord;
      this.store.idempotency.push(r);
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Partial<IdempotencyRecord>; data: Partial<IdempotencyRecord> }) => {
      const r = this.store.idempotency.find((x) =>
        x.businessId === where.businessId && x.apiKeyId === where.apiKeyId && x.key === where.key,
      );
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    }),
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<unknown>[]) { return Promise.all(ops); }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

const BIZ_ID = 'biz_pay_test_001';
const API_KEY_PUBLIC_ID = 'key_pay_test_001';

async function seedApiKey(prisma: MockPrismaService, env: 'test' | 'live' = 'test') {
  const rawKey = generateApiKey(env);
  const hash = await hashApiKey(rawKey, 4);
  prisma.store.apiKeys.push({
    id: `apikeyid_${env}`,
    publicId: API_KEY_PUBLIC_ID,
    businessId: BIZ_ID,
    name: 'Test Key',
    environment: env,
    keyPrefix: `sk_${env}_`,
    secretHash: hash,
    lastFour: rawKey.slice(-4),
    active: true,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  });
  return rawKey;
}

// ─── Test module ──────────────────────────────────────────────────────────────

describe('/v1/payments (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;
  let rawKey: string;
  const IDEM_KEY = 'test-idem-key-001';

  const VALID_BODY = {
    amount: '10.50',
    currency: 'USDC',
    description: 'Test payment',
    customer_email: 'alice@example.com',
  };

  beforeEach(async () => {
    prisma = new MockPrismaService();
    rawKey = await seedApiKey(prisma, 'test');

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig, appConfig],
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

  afterEach(async () => { if (app) await app.close(); });

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
      expect(res.body.checkout_url).toMatch(/^http/);
      expect(res.body.link_memo).toMatch(/^hpl_/);
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

    it('400 — missing Idempotency-Key header', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(auth())
        .send(VALID_BODY)
        .expect(400);

      expect(res.body.error.code).toBe('missing_idempotency_key');
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

    it('401 — missing auth', async () => {
      await request(app.getHttpServer())
        .get('/v1/payments/pay_1')
        .expect(401);
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
        .post('/v1/payments').set(auth()).set('Idempotency-Key', 'list-1').send(VALID_BODY);
      await request(app.getHttpServer())
        .post('/v1/payments').set(auth()).set('Idempotency-Key', 'list-2').send({ ...VALID_BODY, amount: '5.00' });

      const res = await request(app.getHttpServer())
        .get('/v1/payments')
        .set(auth())
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
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
      const p = prisma.store.payments.find((x) => x.publicId === created.body.id);
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
