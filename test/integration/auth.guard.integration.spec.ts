/**
 * Integration test for ApiKeyGuard.
 *
 * Spins up a minimal NestJS app with a test controller protected by
 * ApiKeyGuard. PrismaService is replaced with a deterministic in-memory
 * store — no live DB required.
 *
 * Verifies:
 *  - Valid test key → 200 with merchant context in response body
 *  - Valid live key → 200 with environment='live'
 *  - Missing Authorization header → 401 authentication_error
 *  - Non-Bearer scheme → 401 authentication_error
 *  - Unknown key (not in store) → 401 invalid_api_key
 *  - Revoked key (active=false) → 401 invalid_api_key
 *  - Error response is wrapped in { error: { type, code, message } }
 */

import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { ApiKeyGuard } from '@/common/guards/api-key.guard';
import {
  CurrentMerchant,
  type MerchantContext,
} from '@/common/decorators/current-merchant.decorator';
import { AuthModule } from '@/modules/auth/auth.module';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { hashApiKey, generateApiKey } from '@/common/utils/crypto.util';
import type { ApiKey } from '@prisma/client';
import securityConfig from '@/common/config/security.config';

// ─── In-memory Prisma mock ────────────────────────────────────────────────────

class MockPrismaService {
  private keys: ApiKey[] = [];

  seed(key: ApiKey) {
    this.keys.push(key);
  }

  readonly apiKey = {
    findMany: async (args: { where: Record<string, unknown> }) => {
      return this.keys.filter((k) =>
        Object.entries(args.where).every(
          ([field, val]) => k[field as keyof ApiKey] === val,
        ),
      );
    },
    update: async (args: { where: { id: string }; data: Partial<ApiKey> }) => {
      const key = this.keys.find((k) => k.id === args.where.id);
      if (key) Object.assign(key, args.data);
      return key!;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      return (
        this.keys.find((k) =>
          Object.entries(args.where).every(
            ([f, v]) => k[f as keyof ApiKey] === v,
          ),
        ) ?? null
      );
    },
    create: async (args: { data: Omit<ApiKey, 'id'> }) => {
      const created = { id: `gen_${Date.now()}`, ...args.data } as ApiKey;
      this.keys.push(created);
      return created;
    },
  };

  async $connect() {}
  async $disconnect() {}
  async $transaction(ops: Promise<unknown>[]) {
    return Promise.all(ops);
  }
}

// ─── Test controller ──────────────────────────────────────────────────────────

@Controller('test')
@UseGuards(ApiKeyGuard)
class TestController {
  @Get('me')
  me(@CurrentMerchant() merchant: MerchantContext) {
    return merchant;
  }
}

/**
 * TestFeatureModule imports AuthModule so that ApiKeyGuard can resolve
 * ApiKeyService from the shared module graph.
 */
@Module({
  imports: [AuthModule],
  controllers: [TestController],
})
class TestFeatureModule {}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function seedKey(
  prisma: MockPrismaService,
  environment: 'test' | 'live' = 'test',
  active = true,
): Promise<string> {
  const rawKey = generateApiKey(environment);
  const hash = await hashApiKey(rawKey, 4); // low rounds for test speed
  const prefix = `sk_${environment}_`;

  prisma.seed({
    id: `id_${Date.now()}_${Math.random()}`,
    publicId: `key_${Date.now()}`,
    businessId: 'biz_integration_001',
    name: 'Integration Test Key',
    environment,
    keyPrefix: prefix,
    secretHash: hash,
    lastFour: rawKey.slice(-4),
    active,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: active ? null : new Date(),
  });

  return rawKey;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ApiKeyGuard (integration)', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = new MockPrismaService();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig],
          ignoreEnvFile: true,
        }),
        TestFeatureModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  it('200 — valid test key resolves merchant context', async () => {
    const rawKey = await seedKey(prisma, 'test');

    const res = await request(app.getHttpServer())
      .get('/test/me')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(200);

    expect(res.body.businessId).toBe('biz_integration_001');
    expect(res.body.environment).toBe('test');
    expect(res.body.apiKeyId).toMatch(/^key_/);
  });

  it('200 — valid live key resolves live environment', async () => {
    const rawKey = await seedKey(prisma, 'live');

    const res = await request(app.getHttpServer())
      .get('/test/me')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(200);

    expect(res.body.environment).toBe('live');
  });

  // ─── Auth failures ──────────────────────────────────────────────────────────

  it('401 — missing Authorization header', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/me')
      .expect(401);

    expect(res.body.error.type).toBe('authentication_error');
    expect(res.body.error.code).toBe('missing_api_key');
  });

  it('401 — wrong scheme (Basic auth)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);

    expect(res.body.error.type).toBe('authentication_error');
  });

  it('401 — unknown key (not in store)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/me')
      .set('Authorization', 'Bearer sk_test_totallyFakeKeyThatDoesNotExistXXXXX')
      .expect(401);

    expect(res.body.error.type).toBe('authentication_error');
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  it('401 — revoked key (active=false)', async () => {
    const rawKey = await seedKey(prisma, 'test', false);

    const res = await request(app.getHttpServer())
      .get('/test/me')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(401);

    expect(res.body.error.type).toBe('authentication_error');
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  // ─── Error response shape ───────────────────────────────────────────────────

  it('error response is wrapped in { error: { type, code, message } }', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/me')
      .expect(401);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('type', 'authentication_error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });
});
