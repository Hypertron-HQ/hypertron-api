/**
 * Integration tests — /api/developer/api-keys (Phase 3)
 *
 * Spins up the full DeveloperModule with an in-memory Prisma mock.
 * Exercises all four routes with correct auth, RBAC, and error cases.
 *
 * Routes tested:
 *   GET  /api/developer/api-keys           — list keys
 *   POST /api/developer/api-keys           — create key (Owner/Admin only)
 *   POST /api/developer/api-keys/:id/rotate — rotate key (Owner/Admin only)
 *   POST /api/developer/api-keys/:id/revoke — revoke key (Owner/Admin only)
 *
 * Auth scenarios:
 *   - Missing token → 401
 *   - Invalid token → 401
 *   - Viewer role on mutating route → 403
 *   - Owner role on all routes → passes
 *   - Admin role on mutating routes → passes
 *   - Cross-business isolation → 404
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';

import { DeveloperModule } from '@/modules/developer/developer.module';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import securityConfig from '@/common/config/security.config';
import { generateTestSessionToken } from '@/common/guards/session.guard';
import { hashApiKey, generateApiKey } from '@/common/utils/crypto.util';
import type { ApiKey } from '@prisma/client';
import type { SessionUser } from '@/common/decorators/current-user.decorator';

// ─── In-memory Prisma mock (same pattern as auth integration test) ─────────────

type MembershipRow = {
  id: string;
  userId: string;
  businessId: string;
  role: string;
};

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
      'in' in (expected as object)
    ) {
      const values = (expected as { in: unknown[] }).in;
      return values.includes(actual);
    }
    return actual === expected;
  });
}

class MockPrismaService {
  private keys: ApiKey[] = [];
  private memberships: MembershipRow[] = [];

  seed(key: ApiKey) {
    this.keys.push(key);
  }

  seedMembership(row: MembershipRow) {
    this.memberships.push(row);
  }

  getAll(): ApiKey[] {
    return this.keys;
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

  readonly membership = {
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: { businessId?: boolean };
    }) => {
      const rows = this.memberships.filter((m) =>
        matchesWhere(m as unknown as Record<string, unknown>, args.where),
      );
      if (args.select?.businessId) {
        return rows.map((m) => ({ businessId: m.businessId }));
      }
      return rows;
    },
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<ApiKey>[]) {
    return Promise.all(ops);
  }
}

// ─── Session token helpers ────────────────────────────────────────────────────

function sessionHeader(user: SessionUser): { Authorization: string } {
  return { Authorization: `Bearer ${generateTestSessionToken(user)}` };
}

const OWNER: SessionUser = {
  userId: 'user_owner_001',
  businessId: 'biz_test_001',
  role: 'owner',
};

const ADMIN: SessionUser = {
  userId: 'user_admin_001',
  businessId: 'biz_test_001',
  role: 'admin',
};

const VIEWER: SessionUser = {
  userId: 'user_viewer_001',
  businessId: 'biz_test_001',
  role: 'viewer',
};

const OTHER_BUSINESS: SessionUser = {
  userId: 'user_other_001',
  businessId: 'biz_test_999',
  role: 'owner',
};

// ─── Seed helper ─────────────────────────────────────────────────────────────

let seedCounter = 0;
async function seedKey(
  prisma: MockPrismaService,
  businessId = OWNER.businessId,
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

// ─── Test setup ───────────────────────────────────────────────────────────────

describe('/api/developer/api-keys (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    seedCounter = 0;
    prisma = new MockPrismaService();

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

  // ─── GET /api/developer/api-keys ─────────────────────────────────────────────

  describe('GET /api/developer/api-keys', () => {
    it('200 — returns list with object=list wrapper', async () => {
      await seedKey(prisma);
      await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('200 — each key has correct shape with secret_key=null', async () => {
      await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .expect(200);

      const key = res.body.data[0];
      expect(key.id).toMatch(/^key_/);
      expect(key.object).toBe('api_key');
      expect(key.secret_key).toBeNull();
      expect(key).not.toHaveProperty('secretHash');
      expect(key).not.toHaveProperty('secret_hash');
    });

    it('200 — returns empty list when no keys exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('200 — viewer role can list keys', async () => {
      await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(VIEWER))
        .expect(200);
    });

    it('200 — only returns keys belonging to the authenticated business', async () => {
      await seedKey(prisma, OWNER.businessId);
      await seedKey(prisma, 'biz_other_999'); // different business

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      for (const key of res.body.data) {
        expect(key.id).toMatch(/^key_/);
      }
    });

    it('200 — resolves merchant via Membership when present', async () => {
      prisma.seedMembership({
        id: 'mem_1',
        userId: OWNER.userId,
        businessId: 'biz_from_membership',
        role: 'owner',
      });
      await seedKey(prisma, 'biz_from_membership');
      await seedKey(prisma, OWNER.businessId); // session fallback business — ignored when membership exists

      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toMatch(/^key_/);
    });

    it('401 — missing token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
      expect(res.body.error.code).toBe('missing_session_token');
    });

    it('401 — invalid / malformed token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/developer/api-keys')
        .set('Authorization', 'Bearer notvalidbase64!!!json')
        .expect(401);

      expect(res.body.error.type).toBe('authentication_error');
      expect(res.body.error.code).toBe('invalid_session_token');
    });
  });

  // ─── POST /api/developer/api-keys ────────────────────────────────────────────

  describe('POST /api/developer/api-keys', () => {
    it('201 — creates a key and returns secret_key once', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ name: 'My Server Key', environment: 'test' })
        .expect(201);

      expect(res.body.object).toBe('api_key');
      expect(res.body.id).toMatch(/^key_/);
      expect(res.body.name).toBe('My Server Key');
      expect(res.body.environment).toBe('test');
      // secret_key must be present and non-null on creation
      expect(typeof res.body.secret_key).toBe('string');
      expect(res.body.secret_key).toMatch(/^sk_test_/);
      expect(res.body.active).toBe(true);
    });

    it('201 — creates a live key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ name: 'Live Key', environment: 'live' })
        .expect(201);

      expect(res.body.environment).toBe('live');
      expect(res.body.secret_key).toMatch(/^sk_live_/);
    });

    it('201 — admin can create a key', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(ADMIN))
        .send({ name: 'Admin Key', environment: 'test' })
        .expect(201);
    });

    it('403 — viewer cannot create a key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(VIEWER))
        .send({ name: 'Viewer Key', environment: 'test' })
        .expect(403);

      expect(res.body.error.type).toBe('permission_error');
    });

    it('400 — missing name field', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ environment: 'test' })
        .expect(400);

      expect(res.body).toHaveProperty('message');
    });

    it('400 — invalid environment value', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ name: 'My Key', environment: 'staging' })
        .expect(400);

      expect(res.body).toHaveProperty('message');
    });

    it('400 — empty name', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ name: '', environment: 'test' })
        .expect(400);
    });

    it('400 — extra unknown field is rejected (whitelist)', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .set(sessionHeader(OWNER))
        .send({ name: 'Key', environment: 'test', extra: 'field' })
        .expect(400);
    });

    it('401 — missing token', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys')
        .send({ name: 'Key', environment: 'test' })
        .expect(401);
    });
  });

  // ─── POST /api/developer/api-keys/:id/rotate ─────────────────────────────────

  describe('POST /api/developer/api-keys/:id/rotate', () => {
    it('200 — rotates a key and returns new secret_key', async () => {
      const { record } = await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.object).toBe('api_key');
      // New id should differ from the old one
      expect(res.body.id).not.toBe(record.publicId);
      // secret_key is non-null after rotation
      expect(typeof res.body.secret_key).toBe('string');
      expect(res.body.active).toBe(true);
    });

    it('200 — admin can rotate a key', async () => {
      const { record } = await seedKey(prisma);

      await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionHeader(ADMIN))
        .expect(200);
    });

    it('404 — key not found for this business', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys/key_doesnotexist/rotate')
        .set(sessionHeader(OWNER))
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — cannot rotate another business key (cross-business isolation)', async () => {
      // Seed a key for OTHER_BUSINESS
      const { record } = await seedKey(prisma, OTHER_BUSINESS.businessId);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionHeader(OWNER)) // OWNER is biz_test_001, not biz_test_999
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('403 — viewer cannot rotate a key', async () => {
      const { record } = await seedKey(prisma);

      await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/rotate`)
        .set(sessionHeader(VIEWER))
        .expect(403);
    });

    it('401 — missing token', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys/key_001/rotate')
        .expect(401);
    });
  });

  // ─── POST /api/developer/api-keys/:id/revoke ─────────────────────────────────

  describe('POST /api/developer/api-keys/:id/revoke', () => {
    it('200 — revokes the key and returns active=false', async () => {
      const { record } = await seedKey(prisma);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/revoke`)
        .set(sessionHeader(OWNER))
        .expect(200);

      expect(res.body.object).toBe('api_key');
      expect(res.body.active).toBe(false);
      expect(res.body.secret_key).toBeNull();
    });

    it('200 — admin can revoke a key', async () => {
      const { record } = await seedKey(prisma);

      await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/revoke`)
        .set(sessionHeader(ADMIN))
        .expect(200);
    });

    it('404 — key not found', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/api-keys/key_doesnotexist/revoke')
        .set(sessionHeader(OWNER))
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('404 — cannot revoke another business key (cross-business isolation)', async () => {
      const { record } = await seedKey(prisma, OTHER_BUSINESS.businessId);

      const res = await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/revoke`)
        .set(sessionHeader(OWNER))
        .expect(404);

      expect(res.body.error.type).toBe('resource_missing');
    });

    it('403 — viewer cannot revoke a key', async () => {
      const { record } = await seedKey(prisma);

      await request(app.getHttpServer())
        .post(`/api/developer/api-keys/${record.publicId}/revoke`)
        .set(sessionHeader(VIEWER))
        .expect(403);
    });

    it('401 — missing token', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/api-keys/key_001/revoke')
        .expect(401);
    });
  });
});
