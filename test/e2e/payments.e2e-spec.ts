/**
 * Phase 10 E2E — full HTTP stack against Docker Mongo + Redis.
 *
 * Covers Plan §19.4:
 *  - Auth (valid / missing / revoked / cross-merchant)
 *  - Create → get → cancel lifecycle
 *  - Pagination cursor stability
 *  - Rate limit enforcement (5 creates → 6th = 429)
 *  - Webhook signing (merchant-side verify of /test delivery)
 *  - Health shape
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { verifyWebhookSignature } from '@/common/utils/crypto.util';
import {
  authHeader,
  createE2eApp,
  resetE2eDb,
  seedApiKey,
  seedBusiness,
  sessionCookie,
  WALLET_A,
  WALLET_B,
} from './helpers/e2e-app';

const BIZ_A = 'biz_e2e_a';
const BIZ_B = 'biz_e2e_b';

describe('HyperTone Payments API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let rawKeyA: string;
  let rawKeyB: string;
  let apiKeyAId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  beforeEach(async () => {
    await resetE2eDb(prisma);
    await seedBusiness(prisma, { id: BIZ_A, walletAddress: WALLET_A });
    await seedBusiness(prisma, { id: BIZ_B, walletAddress: WALLET_B });
    const a = await seedApiKey(prisma, { businessId: BIZ_A });
    rawKeyA = a.rawKey;
    apiKeyAId = a.publicId;
    ({ rawKey: rawKeyB } = await seedApiKey(prisma, { businessId: BIZ_B }));
  });

  it('GET /health returns expected shape', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('info');
  });

  describe('authentication', () => {
    it('rejects missing API key with 401', async () => {
      await request(app.getHttpServer()).get('/v1/payments').expect(401);
    });

    it('rejects revoked API key with 401', async () => {
      await prisma.apiKey.update({
        where: { publicId: apiKeyAId },
        data: { active: false, revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get('/v1/payments')
        .set(authHeader(rawKeyA))
        .expect(401);
    });

    it('accepts a valid API key', async () => {
      await request(app.getHttpServer())
        .get('/v1/payments')
        .set(authHeader(rawKeyA))
        .expect(200);
    });

    it('hides merchant A payments from merchant B', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(authHeader(rawKeyA))
        .set('Idempotency-Key', 'e2e-iso-1')
        .send({ amount: '1.00', currency: 'USDC' })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/v1/payments/${created.body.id}`)
        .set(authHeader(rawKeyB))
        .expect(404);
    });
  });

  describe('payment lifecycle', () => {
    it('create → get → cancel', async () => {
      const create = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(authHeader(rawKeyA))
        .set('Idempotency-Key', 'e2e-life-1')
        .send({
          amount: '25.00',
          currency: 'USDC',
          description: 'e2e lifecycle',
          customer_email: 'ada@example.com',
        })
        .expect(201);

      expect(create.body.object).toBe('payment');
      expect(create.body.status).toMatch(/^(created|pending)$/);
      expect(create.body.checkout_url).toContain('http');
      expect(create.headers['x-request-id']).toBeDefined();

      const got = await request(app.getHttpServer())
        .get(`/v1/payments/${create.body.id}`)
        .set(authHeader(rawKeyA))
        .expect(200);
      expect(got.body.id).toBe(create.body.id);

      const canceled = await request(app.getHttpServer())
        .post(`/v1/payments/${create.body.id}/cancel`)
        .set(authHeader(rawKeyA))
        .expect(200);
      expect(canceled.body.status).toBe('canceled');
      expect(canceled.body.canceled_at).toBeTruthy();

      const events = await request(app.getHttpServer())
        .get(`/v1/payments/${create.body.id}/events`)
        .set(authHeader(rawKeyA))
        .expect(200);
      expect(events.body.object).toBe('list');
      expect(events.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('pagination', () => {
    it('cursor remains stable when new rows are inserted', async () => {
      for (let i = 0; i < 4; i++) {
        await request(app.getHttpServer())
          .post('/v1/payments')
          .set(authHeader(rawKeyA))
          .set('Idempotency-Key', `e2e-page-seed-${i}`)
          .send({ amount: '1.00', currency: 'USDC' })
          .expect(201);
      }

      const page1 = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ limit: 3 })
        .set(authHeader(rawKeyA))
        .expect(200);

      expect(page1.body.data).toHaveLength(3);
      expect(page1.body.has_more).toBe(true);
      expect(page1.body.next_cursor).toBeTruthy();
      const firstPageIds = page1.body.data.map((p: { id: string }) => p.id);

      await request(app.getHttpServer())
        .post('/v1/payments')
        .set(authHeader(rawKeyA))
        .set('Idempotency-Key', 'e2e-page-insert-mid')
        .send({ amount: '9.00', currency: 'USDC' })
        .expect(201);

      const page2 = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ limit: 3, cursor: page1.body.next_cursor })
        .set(authHeader(rawKeyA))
        .expect(200);

      const page2Ids = page2.body.data.map((p: { id: string }) => p.id);
      for (const id of firstPageIds) {
        expect(page2Ids).not.toContain(id);
      }
    });
  });

  describe('rate limits', () => {
    it('returns 429 after payment-create budget is exhausted', async () => {
      const limit = Number(
        process.env.RATE_LIMIT_PAYMENT_CREATE_PER_MIN ?? '5',
      );

      for (let i = 0; i < limit; i++) {
        await request(app.getHttpServer())
          .post('/v1/payments')
          .set(authHeader(rawKeyA))
          .set('Idempotency-Key', `e2e-rl-${i}-${Date.now()}`)
          .send({ amount: '1.00', currency: 'USDC' })
          .expect(201);
      }

      const blocked = await request(app.getHttpServer())
        .post('/v1/payments')
        .set(authHeader(rawKeyA))
        .set('Idempotency-Key', `e2e-rl-over-${Date.now()}`)
        .send({ amount: '1.00', currency: 'USDC' })
        .expect(429);

      expect(blocked.body.error).toMatchObject({
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      });
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.headers['x-ratelimit-limit']).toBeDefined();
    });
  });

  describe('webhook signing', () => {
    it('signs test deliveries that merchants can verify', async () => {
      const received: { headers: IncomingMessage['headers']; body: string }[] =
        [];

      const receiver: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      });

      await new Promise<void>((resolve) =>
        receiver.listen(0, '127.0.0.1', resolve),
      );
      const port = (receiver.address() as AddressInfo).port;
      const webhookUrl = `http://127.0.0.1:${port}/hook`;

      try {
        const created = await request(app.getHttpServer())
          .post('/api/developer/webhook-endpoints')
          .set('Cookie', sessionCookie(WALLET_A))
          .send({
            url: webhookUrl,
            environment: 'test',
            events: ['payment.completed'],
            description: 'e2e signer',
          })
          .expect(201);

        const signingSecret = created.body.signing_secret as string;
        expect(signingSecret).toMatch(/^[0-9a-f]{64}$/);

        await request(app.getHttpServer())
          .post(`/api/developer/webhook-endpoints/${created.body.id}/test`)
          .set('Cookie', sessionCookie(WALLET_A))
          .expect(200);

        expect(received.length).toBe(1);
        const sig = received[0].headers['hypertron-signature'];
        expect(typeof sig).toBe('string');
        expect(
          verifyWebhookSignature(String(sig), signingSecret, received[0].body),
        ).toBe(true);
        expect(received[0].headers['hypertron-event-id']).toBeDefined();
        expect(received[0].headers['hypertron-delivery-id']).toBeDefined();
      } finally {
        await new Promise<void>((resolve, reject) =>
          receiver.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });
  });
});
