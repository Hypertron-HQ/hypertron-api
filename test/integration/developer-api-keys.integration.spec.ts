/**
 * Integration tests — /api/developer/api-keys
 *
 * Freighter ht_dashboard cookie auth (shared AUTH_SECRET with core).
 */

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';

import { DeveloperModule } from '@/modules/developer/developer.module';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import securityConfig from '@/common/config/security.config';
import { generateTestSessionCookie } from '@/common/guards/session.guard';
import { DASHBOARD_SESSION_COOKIE } from '@/common/auth/dashboard-session';
import { hashApiKey, generateApiKey } from '@/common/utils/crypto.util';
import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import { passThroughThrottlerGuard } from '../helpers/passthrough-throttler';
import type { ApiKey } from '@prisma/client';

const AUTH_SECRET = 'test-auth-secret-for-integration';
const OWNER_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_WALLET = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
const OWNER_BUSINESS_ID = 'biz_test_001';
const OTHER_BUSINESS_ID = 'biz_test_999';

function matchesWhere<T extends Record<string, unknown>>(
  row: T,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = row[field];
    if (
      expected !== null &&
      typeof expected === 'object' &&
      !Array.isArray(expected) &&
      'in' in expected
    ) {
      const values = (expected as { in: unknown[] }).in;
      return values.includes(actual);
    }
    return actual === expected;
  });
}

class MockPrismaService {
  private keys: ApiKey[] = [];
  private merchantSettingsRows: {
    businessId: string;
    walletAddress: string;
  }[] = [
    { businessId: OWNER_BUSINESS_ID, walletAddress: OWNER_WALLET },
    { businessId: OTHER_BUSINESS_ID, walletAddress: OTHER_WALLET },
  ];

  seed(key: ApiKey) {
    this.keys.push(key);
  }

  readonly apiKey = {
    findMany: async (args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
    }) => {
      return this.keys.filter((k) =>
        matchesWhere(k as unknown as Record<string, unknown>, args.where),
      );
    },
    findFirst: async (args: { where: Record<string, unknown> }) =>
      this.keys.find((k) =>
        matchesWhere(k as unknown as Record<string, unknown>, args.where),
      ) ?? null,
    create: async (args: { data: Omit<ApiKey, 'id'> }) => {
      const data = args.data as ApiKey;
      const created: ApiKey = {
        ...data,
        id: `gen_${Date.now()}_${Math.random()}`,
        createdAt: data.createdAt ?? new Date(),
        lastUsedAt: data.lastUsedAt ?? null,
        revokedAt: data.revokedAt ?? null,
      };
      this.keys.push(created);
      return created;
    },
    update: async (args: { where: { id: string }; data: Partial<ApiKey> }) => {
      const key = this.keys.find((k) => k.id === args.where.id);
      if (key) Object.assign(key, args.data);
      return key!;
    },
  };

  readonly merchantSettings = {
    findUnique: async (args: {
      where: { walletAddress?: string; businessId?: string };
      select?: { businessId?: boolean };
    }) => {
      const row = this.merchantSettingsRows.find((b) =>
        args.where.walletAddress
          ? b.walletAddress === args.where.walletAddress
          : b.businessId === args.where.businessId,
      );
      if (!row) return null;
      return args.select?.businessId ? { businessId: row.businessId } : row;
    },
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<ApiKey>[]) {
    return Promise.all(ops);
  }
}

function sessionCookie(walletAddress: string): { Cookie: string } {
  const token = generateTestSessionCookie(walletAddress, AUTH_SECRET);
  return { Cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` };
}

let seedCounter = 0;
async function seedKey(
  prisma: MockPrismaService,
  businessId = OWNER_BUSINESS_ID,
  environment: 'test' | 'live' = 'test',
  active = true,
): Promise<{ rawKey: string; record: ApiKey }> {
  seedCounter++;
  const rawKey = generateApiKey(environment);
  const hash = await hashApiKey(rawKey, 4);
  const prefix = `sk_${environment}_`;

  const record: ApiKey = {
    id: `id_${seedCounter}`,
    publicId: `key_seed_${seedCounter}`,
    businessId,
    name: `Seeded Key ${seedCounter}`,
    environment,
    keyPrefix: prefix,
    secretHash: hash,
    lastFour: rawKey.slice(-4),
    active,
    lastUsedAt: null,
    createdAt: new Date('2024-01-01'),
    revokedAt: active ? null : new Date(),
  };

  prisma.seed(record);
  return { rawKey, record };
}

describe('/api/developer/api-keys (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    seedCounter = 0;
    prisma = new MockPrismaService();
    process.env.AUTH_SECRET = AUTH_SECRET;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig],
          ignoreEnvFile: true,
        }),
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

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /api/developer/api-keys', () => {
    it('200 — returns list with object=list wrapper', async () => {
      await seedKey(prisma);
      await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('200 — each key has correct shape with secret_key=null', async () => {
      await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      const key = res.body.data[0];
      expect(key.id).toMatch(/^key_/);
      expect(key.object).toBe('api_key');
      expect(key.secret_key).toBeNull();
      expect(key).not.toHaveProperty('secretHash');
    });

    it('200 — returns empty list when no keys exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('200 — only returns keys belonging to the authenticated business', async () => {
      await seedKey(prisma, OWNER_BUSINESS_ID);
      await seedKey(prisma, OTHER_BUSINESS_ID);

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('401 — missing cookie', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
      expect(res.body.error.code).toBe('missing_session_token');
    });

    it('401 — invalid cookie', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set('Cookie', `${DASHBOARD_SESSION_COOKIE}=not.valid.token`)
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
      expect(res.body.error.code).toBe('invalid_session_token');
    });
  });

  describe('POST /api/developer/api-keys', () => {
    it('201 — creates a key and returns secret_key once', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionCookie(OWNER_WALLET))
        .send({ name: 'My Key', environment: 'test' })
        .expect(201);

      expect(res.body.secret_key).toMatch(/^sk_test_/);
      expect(res.body.id).toMatch(/^key_/);
      expect(res.body.object).toBe('api_key');
    });

    it('401 — missing cookie', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .send({ name: 'My Key', environment: 'test' })
        .expect(401);
    });
  });

  describe('POST /api/developer/api-keys/:id/rotate', () => {
    it('200 — rotates and returns new secret_key', async () => {
      const { record } = await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.secret_key).toMatch(/^sk_test_/);
      expect(res.body.id).not.toBe(record.publicId);
    });

    it('404 — key from another business', async () => {
      const { record } = await seedKey(prisma, OTHER_BUSINESS_ID);

      await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });

  describe('POST /api/developer/api-keys/:id/revoke', () => {
    it('200 — revokes key', async () => {
      const { record } = await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/revoke`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.secret_key).toBeNull();
      expect(res.body.id).toBe(record.publicId);
    });

    it('404 — already revoked / missing', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys/key_missing/revoke')
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });
});
