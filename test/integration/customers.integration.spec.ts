/**
 * Integration tests — Phase 5 Customer API
 *
 * Covers:
 *   GET /v1/customers         — API-key auth, list with has_more/cursor
 *   GET /v1/customers/:id     — retrieve single customer, 404
 *   GET /api/developer/customers       — session auth, list
 *   GET /api/developer/customers/:id   — session auth, retrieve
 *
 * Auth/isolation scenarios:
 *   - 401 on missing auth (both planes)
 *   - 404 for customer belonging to different business
 *   - Cross-merchant isolation enforced
 */

import { Module, Controller, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { Customer, ApiKey } from '@prisma/client';

import securityConfig from '@/common/config/security.config';
import appConfig from '@/common/config/app.config';
import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import { passThroughThrottlerGuard } from '../helpers/passthrough-throttler';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { CustomersModule } from '@/modules/customers/customers.module';
import { DeveloperModule } from '@/modules/developer/developer.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { generateApiKey, hashApiKey } from '@/common/utils/crypto.util';
import { generateTestSessionCookie } from '@/common/guards/session.guard';
import { DASHBOARD_SESSION_COOKIE } from '@/common/auth/dashboard-session';

// ─── In-memory store ──────────────────────────────────────────────────────────

class MockPrismaService {
  customers: Customer[] = [];
  apiKeys: ApiKey[] = [];
  businesses: { id: string; walletAddress: string }[] = [
    { id: 'biz_cust_test_A', walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
    { id: 'biz_cust_test_B', walletAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF' },
  ];

  private seq = 0;
  id() { return `oid_${++this.seq}`; }

  readonly customer = {
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      this.customers.find((c) =>
        Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
      ) ?? null,
    ),
    findMany: jest.fn(async ({ where, take }: {
      where?: Record<string, unknown> & { OR?: Array<Record<string, unknown>> };
      take?: number;
      orderBy?: object[];
    }) => {
      let rows = this.customers.filter((c) => {
        if (!where) return true;
        if (where.businessId && c.businessId !== where.businessId) return false;
        if (where.OR?.length) {
          return where.OR.some((clause) => {
            const createdAt = clause.createdAt as Date | { lt?: Date } | undefined;
            if (
              createdAt &&
              typeof createdAt === 'object' &&
              !(createdAt instanceof Date) &&
              createdAt.lt
            ) {
              return c.createdAt.getTime() < createdAt.lt.getTime();
            }
            if (createdAt instanceof Date && typeof clause.id === 'object') {
              const idClause = clause.id as { lt?: string };
              return (
                c.createdAt.getTime() === createdAt.getTime() &&
                !!idClause.lt &&
                c.id < idClause.lt
              );
            }
            return false;
          });
        }
        return Object.entries(where).every(([k, v]) => {
          if (k === 'OR') return true;
          return (c as Record<string, unknown>)[k] === v;
        });
      });
      rows = rows.slice().sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      });
      if (take) rows = rows.slice(0, take);
      return rows;
    }),
    create: jest.fn(async ({ data }: { data: Partial<Customer> }) => {
      const c: Customer = {
        id: this.id(),
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
      this.customers.push(c);
      return c;
    }),
  };

  readonly apiKey = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      this.apiKeys.filter((k) =>
        Object.entries(where).every(([f, v]) => (k as Record<string, unknown>)[f] === v),
      ),
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      this.apiKeys.find((k) =>
        Object.entries(where).every(([f, v]) => (k as Record<string, unknown>)[f] === v),
      ) ?? null,
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ApiKey> }) => {
      const k = this.apiKeys.find((x) => x.id === where.id);
      if (k) Object.assign(k, data);
      return k!;
    }),
    create: jest.fn(async ({ data }: { data: Partial<ApiKey> }) => {
      const k = { id: this.id(), createdAt: new Date(), lastUsedAt: null, revokedAt: null, active: true, ...data } as ApiKey;
      this.apiKeys.push(k);
      return k;
    }),
  };

  readonly business = {
    findUnique: jest.fn(async ({ where }: { where: { walletAddress?: string; id?: string }; select?: { id?: boolean } }) => {
      const row = this.businesses.find((b) =>
        where.walletAddress ? b.walletAddress === where.walletAddress : b.id === where.id,
      );
      if (!row) return null;
      return { id: row.id };
    }),
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<unknown>[]) { return Promise.all(ops); }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BIZ_A = 'biz_cust_test_A';
const BIZ_B = 'biz_cust_test_B';

async function seedApiKey(prisma: MockPrismaService, biz = BIZ_A) {
  const rawKey = generateApiKey('test');
  const hash = await hashApiKey(rawKey, 4);
  prisma.apiKeys.push({
    id: prisma.id(),
    publicId: `key_${biz}`,
    businessId: biz,
    name: 'Test Key',
    environment: 'test',
    keyPrefix: 'sk_test_',
    secretHash: hash,
    lastFour: rawKey.slice(-4),
    active: true,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  });
  return rawKey;
}

function seedCustomer(prisma: MockPrismaService, biz = BIZ_A, overrides: Partial<Customer> = {}): Customer {
  const c: Customer = {
    id: prisma.id(),
    publicId: `cus_${prisma.id()}`,
    businessId: biz,
    email: `user${Math.random()}@example.com`,
    name: 'Test User',
    metadata: {},
    paymentCount: 0,
    lifetimeValue: '0.00',
    lifetimeValueCurrency: 'USDC',
    lastPaymentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  prisma.customers.push(c);
  return c;
}

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
const AUTH_SECRET = 'test-auth-secret-for-integration';

const ownerSession = (biz = BIZ_A): { Cookie: string } => {
  const wallet = biz === BIZ_B ? WALLET_B : WALLET_A;
  const token = generateTestSessionCookie(wallet, AUTH_SECRET);
  return { Cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` };
};


// ─── Test setup ───────────────────────────────────────────────────────────────

describe('Customer API (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;
  let rawKey: string;

  beforeEach(async () => {
    prisma = new MockPrismaService();
    process.env.AUTH_SECRET = AUTH_SECRET;
    rawKey = await seedApiKey(prisma, BIZ_A);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig, appConfig],
          ignoreEnvFile: true,
        }),
        CustomersModule,
        DeveloperModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideGuard(HypertronThrottlerGuard)
      .useValue(passThroughThrottlerGuard)
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

  const apiAuth = () => ({ Authorization: `Bearer ${rawKey}` });

  // ─── GET /v1/customers ──────────────────────────────────────────────────────

  describe('GET /v1/customers', () => {
    it('200 — returns list envelope', async () => {
      seedCustomer(prisma);
      const res = await request(app.getHttpServer())
        .get('/v1/customers')
        .set(apiAuth())
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(typeof res.body.has_more).toBe('boolean');
      expect(res.body).toHaveProperty('next_cursor');
    });

    it('200 — each customer has correct shape', async () => {
      seedCustomer(prisma, BIZ_A, { email: 'alice@example.com', name: 'Alice' });

      const res = await request(app.getHttpServer())
        .get('/v1/customers')
        .set(apiAuth())
        .expect(200);

      const c = res.body.data[0];
      expect(c.object).toBe('customer');
      expect(c.id).toMatch(/^cus_/);
      expect(c).toHaveProperty('email');
      expect(c).toHaveProperty('payment_count');
      expect(c).toHaveProperty('lifetime_value');
      expect(c).not.toHaveProperty('_id');
    });

    it('200 — empty list when no customers', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/customers')
        .set(apiAuth())
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.has_more).toBe(false);
      expect(res.body.next_cursor).toBeNull();
    });

    it('400 — limit > 100 rejected', async () => {
      await request(app.getHttpServer())
        .get('/v1/customers?limit=101')
        .set(apiAuth())
        .expect(400);
    });

    it('200 — has_more=true and cursor returns remaining page', async () => {
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        seedCustomer(prisma, BIZ_A, {
          publicId: `cus_page_${i}`,
          email: `page${i}@example.com`,
          createdAt: new Date(base - i * 1000),
        });
      }

      const page1 = await request(app.getHttpServer())
        .get('/v1/customers?limit=2')
        .set(apiAuth())
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.next_cursor).toEqual(expect.any(String));

      const page2 = await request(app.getHttpServer())
        .get(`/v1/customers?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`)
        .set(apiAuth())
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.has_more).toBe(false);
      expect(page2.body.next_cursor).toBeNull();

      const page1Ids = page1.body.data.map((c: { id: string }) => c.id);
      const page2Ids = page2.body.data.map((c: { id: string }) => c.id);
      expect(page1Ids).not.toEqual(expect.arrayContaining(page2Ids));
    });

    it('401 — missing API key', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/customers')
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
    });
  });

  // ─── GET /v1/customers/:id ─────────────────────────────────────────────────

  describe('GET /v1/customers/:id', () => {
    it('200 — returns the customer', async () => {
      const c = seedCustomer(prisma, BIZ_A, { email: 'bob@example.com' });

      const res = await request(app.getHttpServer())
        .get(`/v1/customers/${c.publicId}`)
        .set(apiAuth())
        .expect(200);

      expect(res.body.object).toBe('customer');
      expect(res.body.id).toBe(c.publicId);
      expect(res.body.email).toBe('bob@example.com');
    });

    it('404 — customer not found', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/customers/cus_doesnotexist')
        .set(apiAuth())
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — cross-business isolation (BIZ_B customer not visible to BIZ_A key)', async () => {
      const c = seedCustomer(prisma, BIZ_B); // belongs to a different business

      const res = await request(app.getHttpServer())
        .get(`/v1/customers/${c.publicId}`)
        .set(apiAuth()) // BIZ_A key
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('401 — missing API key', async () => {
      const c = seedCustomer(prisma);
      await request(app.getHttpServer())
        .get(`/v1/customers/${c.publicId}`)
        .expect(401);
    });
  });

  // ─── GET /api/developer/customers ─────────────────────────────────────────

  describe('GET /api/developer/customers', () => {
    it('200 — returns list via session auth', async () => {
      seedCustomer(prisma, BIZ_A);

      const res = await request(app.getHttpServer())
        .get('/api/developer/customers')
        .set(ownerSession(BIZ_A))
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('200 — empty list when no customers', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/customers')
        .set(ownerSession(BIZ_A))
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('401 — missing session token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/customers')
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
    });
  });

  // ─── GET /api/developer/customers/:id ────────────────────────────────────

  describe('GET /api/developer/customers/:id', () => {
    it('200 — returns customer via session auth', async () => {
      const c = seedCustomer(prisma, BIZ_A, { name: 'Dashboard User' });

      const res = await request(app.getHttpServer())
        .get(`/api/developer/customers/${c.publicId}`)
        .set(ownerSession(BIZ_A))
        .expect(200);

      expect(res.body.id).toBe(c.publicId);
      expect(res.body.name).toBe('Dashboard User');
    });

    it('404 — customer not found', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/customers/cus_ghost')
        .set(ownerSession(BIZ_A))
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — cross-business isolation via session', async () => {
      const c = seedCustomer(prisma, BIZ_B); // different business

      const res = await request(app.getHttpServer())
        .get(`/api/developer/customers/${c.publicId}`)
        .set(ownerSession(BIZ_A)) // BIZ_A session
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('401 — missing session token', async () => {
      const c = seedCustomer(prisma);
      await request(app.getHttpServer())
        .get(`/api/developer/customers/${c.publicId}`)
        .expect(401);
    });
  });
});
