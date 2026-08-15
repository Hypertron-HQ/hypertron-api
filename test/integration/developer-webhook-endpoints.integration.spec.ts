/**
 * Integration tests — /api/developer/webhook-endpoints (Phase 7)
 *
 * Runs the real DeveloperModule (SessionGuard + RolesGuard + controllers) over
 * an in-memory Prisma mock, a fake BullMQ queue, and a mocked fetch.
 *
 * Scenarios:
 *   - Endpoint CRUD, including URL and event-type validation
 *   - signing_secret returned exactly once (create + rotate-secret)
 *   - Cross-merchant isolation returns 404, never another merchant's data
 *   - Delivery log route and test-webhook route
 */

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { WebhookDelivery, WebhookEndpoint } from '@prisma/client';

import securityConfig from '@/common/config/security.config';
import { DeveloperModule } from '@/modules/developer/developer.module';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { WEBHOOK_QUEUE } from '@/modules/webhooks/webhooks.constants';
import { generateTestSessionCookie } from '@/common/guards/session.guard';
import { DASHBOARD_SESSION_COOKIE } from '@/common/auth/dashboard-session';
import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import { passThroughThrottlerGuard } from '../helpers/passthrough-throttler';

const AUTH_SECRET = 'test-auth-secret-for-integration';
const ENCRYPTION_KEY = 'd'.repeat(64);
const OWNER_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_WALLET = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
const OWNER_BUSINESS_ID = 'biz_test_001';
const OTHER_BUSINESS_ID = 'biz_test_999';

class MockPrismaService {
  endpoints: WebhookEndpoint[] = [];
  deliveries: WebhookDelivery[] = [];

  private seq = 0;
  private nextId() {
    return `oid_${++this.seq}`;
  }

  private merchantSettingsRows = [
    { businessId: OWNER_BUSINESS_ID, walletAddress: OWNER_WALLET },
    { businessId: OTHER_BUSINESS_ID, walletAddress: OTHER_WALLET },
  ];

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

  readonly webhookEndpoint = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: this.nextId(),
        description: null,
        active: true,
        disabledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      } as unknown as WebhookEndpoint;
      this.endpoints.push(row);
      return row;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.endpoints.filter((e) => e.businessId === where.businessId),
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.endpoints.find((e) =>
        Object.entries(where).every(
          ([field, value]) => (e as Record<string, unknown>)[field] === value,
        ),
      ) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.endpoints.find((e) => e.id === where.id) ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = this.endpoints.find((e) => e.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = this.endpoints.findIndex((e) => e.id === where.id);
      return this.endpoints.splice(index, 1)[0];
    },
  };

  readonly webhookDelivery = {
    findMany: async ({
      where,
      take,
    }: {
      where: Record<string, unknown>;
      take?: number;
    }) => {
      const rows = this.deliveries.filter(
        (d) => d.endpointId === where.endpointId,
      );
      return take ? rows.slice(0, take) : rows;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.deliveries.find((d) =>
        Object.entries(where).every(
          ([field, value]) => (d as Record<string, unknown>)[field] === value,
        ),
      ) ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = this.deliveries.find((d) => d.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }: { where: { endpointId: string } }) => {
      const before = this.deliveries.length;
      this.deliveries = this.deliveries.filter(
        (d) => d.endpointId !== where.endpointId,
      );
      return { count: before - this.deliveries.length };
    },
  };

  seedDelivery(endpoint: WebhookEndpoint): WebhookDelivery {
    const row = {
      id: this.nextId(),
      publicId: `whd_seed_${this.seq}`,
      businessId: endpoint.businessId,
      endpointId: endpoint.id,
      eventId: `evt_seed_${this.seq}`,
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: null,
      lastAttemptAt: new Date(),
      responseStatus: 200,
      responseBody: 'ok',
      deliveredAt: new Date(),
      createdAt: new Date(),
    } as unknown as WebhookDelivery;
    this.deliveries.push(row);
    return row;
  }

  async $connect() {}
  async $disconnect() {}
}

function sessionCookie(walletAddress: string): { Cookie: string } {
  return {
    Cookie: `${DASHBOARD_SESSION_COOKIE}=${generateTestSessionCookie(walletAddress, AUTH_SECRET)}`,
  };
}

describe('/api/developer/webhook-endpoints (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: MockPrismaService;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    process.env.AUTH_SECRET = AUTH_SECRET;
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
    prisma = new MockPrismaService();
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => 'ok',
    });

    moduleRef = await Test.createTestingModule({
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
      .overrideProvider(getQueueToken(WEBHOOK_QUEUE))
      .useValue(queue)
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
    jest.restoreAllMocks();
  });

  async function createEndpoint(
    wallet = OWNER_WALLET,
    body: Record<string, unknown> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post('/api/developer/webhook-endpoints')
      .set(sessionCookie(wallet))
      .send({
        url: 'https://merchant.example.com/hooks',
        environment: 'test',
        events: ['payment.completed'],
        ...body,
      })
      .expect(201);
    return res.body;
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  describe('POST /api/developer/webhook-endpoints', () => {
    it('201 — creates an endpoint and returns signing_secret once', async () => {
      const body = await createEndpoint();

      expect(body.id).toMatch(/^we_/);
      expect(body.object).toBe('webhook_endpoint');
      expect(body.signing_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.secret_last_four).toBe(body.signing_secret.slice(-4));
      expect(body.active).toBe(true);
      expect(body.events).toEqual(['payment.completed']);
    });

    it('never persists the plaintext secret', async () => {
      const body = await createEndpoint();

      const stored = prisma.endpoints[0];
      expect(stored.signingSecretEncrypted).not.toContain(body.signing_secret);
      expect(JSON.stringify(body)).not.toContain('signingSecretEncrypted');
    });

    it('400 — rejects a plain http URL for a public host', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .send({
          url: 'http://merchant.example.com/hooks',
          environment: 'test',
          events: ['payment.completed'],
        })
        .expect(400);

      expect(res.body.error.code).toBe('invalid_webhook_url');
    });

    it('201 — allows http://localhost in the test environment', async () => {
      const body = await createEndpoint(OWNER_WALLET, {
        url: 'http://localhost:4000/hooks',
      });

      expect(body.url).toContain('http://localhost:4000');
    });

    it('400 — rejects http://localhost for live endpoints', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .send({
          url: 'http://localhost:4000/hooks',
          environment: 'live',
          events: ['payment.completed'],
        })
        .expect(400);
    });

    it('400 — rejects an unknown event type', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .send({
          url: 'https://merchant.example.com/hooks',
          environment: 'test',
          events: ['payment.refunded'],
        })
        .expect(400);

      expect(res.body.error.code).toBe('invalid_webhook_events');
    });

    it('400 — rejects an empty events array', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .send({
          url: 'https://merchant.example.com/hooks',
          environment: 'test',
          events: [],
        })
        .expect(400);
    });

    it('401 — missing session cookie', async () => {
      await request(app.getHttpServer())
        .post('/api/developer/webhook-endpoints')
        .send({
          url: 'https://merchant.example.com/hooks',
          environment: 'test',
          events: ['payment.completed'],
        })
        .expect(401);
    });
  });

  // ─── List ───────────────────────────────────────────────────────────────────

  describe('GET /api/developer/webhook-endpoints', () => {
    it('200 — returns a list wrapper with signing_secret null', async () => {
      await createEndpoint();

      const res = await request(app.getHttpServer())
        .get('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].signing_secret).toBeNull();
      expect(res.body.data[0].secret_last_four).toMatch(/^[0-9a-f]{4}$/);
    });

    it('200 — only returns endpoints of the authenticated merchant', async () => {
      await createEndpoint(OWNER_WALLET);
      await createEndpoint(OTHER_WALLET);

      const res = await request(app.getHttpServer())
        .get('/api/developer/webhook-endpoints')
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('401 — missing session cookie', async () => {
      await request(app.getHttpServer())
        .get('/api/developer/webhook-endpoints')
        .expect(401);
    });
  });

  // ─── Update ─────────────────────────────────────────────────────────────────

  describe('PATCH /api/developer/webhook-endpoints/:id', () => {
    it('200 — updates url, events, and description', async () => {
      const created = await createEndpoint();

      const res = await request(app.getHttpServer())
        .patch(`/api/developer/webhook-endpoints/${created.id}`)
        .set(sessionCookie(OWNER_WALLET))
        .send({
          url: 'https://merchant.example.com/hooks/v2',
          events: ['payment.completed', 'payment.failed'],
          description: 'Prod hook',
        })
        .expect(200);

      expect(res.body.url).toContain('/hooks/v2');
      expect(res.body.events).toEqual(['payment.completed', 'payment.failed']);
      expect(res.body.description).toBe('Prod hook');
      expect(res.body.signing_secret).toBeNull();
    });

    it('200 — deactivating stamps disabled_at', async () => {
      const created = await createEndpoint();

      const res = await request(app.getHttpServer())
        .patch(`/api/developer/webhook-endpoints/${created.id}`)
        .set(sessionCookie(OWNER_WALLET))
        .send({ active: false })
        .expect(200);

      expect(res.body.active).toBe(false);
      expect(res.body.disabled_at).toEqual(expect.any(String));
    });

    it('400 — rejects an invalid url on update', async () => {
      const created = await createEndpoint();

      await request(app.getHttpServer())
        .patch(`/api/developer/webhook-endpoints/${created.id}`)
        .set(sessionCookie(OWNER_WALLET))
        .send({ url: 'not-a-url' })
        .expect(400);
    });

    it('404 — endpoint owned by another merchant', async () => {
      const created = await createEndpoint(OTHER_WALLET);

      await request(app.getHttpServer())
        .patch(`/api/developer/webhook-endpoints/${created.id}`)
        .set(sessionCookie(OWNER_WALLET))
        .send({ description: 'hijack' })
        .expect(404);
    });
  });

  // ─── Rotate secret ──────────────────────────────────────────────────────────

  describe('POST /api/developer/webhook-endpoints/:id/rotate-secret', () => {
    it('200 — returns a new secret once and updates last_four', async () => {
      const created = await createEndpoint();

      const res = await request(app.getHttpServer())
        .post(`/api/developer/webhook-endpoints/${created.id}/rotate-secret`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.signing_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.signing_secret).not.toBe(created.signing_secret);
      expect(res.body.secret_last_four).toBe(res.body.signing_secret.slice(-4));
    });

    it('404 — endpoint owned by another merchant', async () => {
      const created = await createEndpoint(OTHER_WALLET);

      await request(app.getHttpServer())
        .post(`/api/developer/webhook-endpoints/${created.id}/rotate-secret`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });

  // ─── Delete ─────────────────────────────────────────────────────────────────

  describe('DELETE /api/developer/webhook-endpoints/:id', () => {
    it('200 — deletes the endpoint and its delivery history', async () => {
      const created = await createEndpoint();
      prisma.seedDelivery(prisma.endpoints[0]);

      const res = await request(app.getHttpServer())
        .delete(`/api/developer/webhook-endpoints/${created.id}`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body).toEqual({
        id: created.id,
        object: 'webhook_endpoint',
        deleted: true,
      });
      expect(prisma.endpoints).toHaveLength(0);
      expect(prisma.deliveries).toHaveLength(0);
    });

    it('404 — unknown endpoint', async () => {
      await request(app.getHttpServer())
        .delete('/api/developer/webhook-endpoints/we_missing')
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });

  // ─── Deliveries ─────────────────────────────────────────────────────────────

  describe('GET /api/developer/webhook-endpoints/:id/deliveries', () => {
    it('200 — returns the delivery log for the endpoint', async () => {
      const created = await createEndpoint();
      prisma.seedDelivery(prisma.endpoints[0]);

      const res = await request(app.getHttpServer())
        .get(`/api/developer/webhook-endpoints/${created.id}/deliveries`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(res.body.has_more).toBe(false);
      expect(res.body.data[0]).toMatchObject({
        object: 'webhook_delivery',
        endpoint_id: created.id,
        status: 'delivered',
        attempt_count: 1,
        response_status: 200,
      });
    });

    it('400 — rejects a limit above 100', async () => {
      const created = await createEndpoint();

      await request(app.getHttpServer())
        .get(
          `/api/developer/webhook-endpoints/${created.id}/deliveries?limit=500`,
        )
        .set(sessionCookie(OWNER_WALLET))
        .expect(400);
    });

    it('404 — endpoint owned by another merchant', async () => {
      const created = await createEndpoint(OTHER_WALLET);

      await request(app.getHttpServer())
        .get(`/api/developer/webhook-endpoints/${created.id}/deliveries`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });

  // ─── Test webhook ───────────────────────────────────────────────────────────

  describe('POST /api/developer/webhook-endpoints/:id/test', () => {
    it('200 — reports a successful test delivery without storing a record', async () => {
      const created = await createEndpoint();

      const res = await request(app.getHttpServer())
        .post(`/api/developer/webhook-endpoints/${created.id}/test`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body).toMatchObject({
        object: 'webhook_test',
        delivered: true,
        response_status: 200,
        response_body: 'ok',
        error: null,
      });
      expect(prisma.deliveries).toHaveLength(0);
    });

    it('200 — reports a failing endpoint without throwing', async () => {
      const created = await createEndpoint();
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 500,
        text: async () => 'server error',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/developer/webhook-endpoints/${created.id}/test`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(200);

      expect(res.body.delivered).toBe(false);
      expect(res.body.response_status).toBe(500);
    });

    it('404 — endpoint owned by another merchant', async () => {
      const created = await createEndpoint(OTHER_WALLET);

      await request(app.getHttpServer())
        .post(`/api/developer/webhook-endpoints/${created.id}/test`)
        .set(sessionCookie(OWNER_WALLET))
        .expect(404);
    });
  });
});
