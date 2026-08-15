/**
 * Integration tests — Phase 7 webhook delivery pipeline
 *
 * Runs WebhookDeliveryService against an in-memory Prisma mock, a fake BullMQ
 * queue, and a mocked fetch. No live DB, Redis, or network required.
 *
 * Scenarios:
 *   - Fan-out selects only subscribed, active, same-environment endpoints
 *   - Fan-out is idempotent on (endpointId, eventId)
 *   - 2xx → delivered; payload matches the immutable event snapshot
 *   - Signature verifies merchant-side over the exact raw body
 *   - 5xx / 429 / network error → retry scheduled on the documented schedule
 *   - 4xx (non-retryable) → failed immediately, no retry job
 *   - Retry schedule exhaustion after seven attempts → failed
 *   - Response bodies truncated to 2 KB
 *   - Manual retry restarts the schedule
 */

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DeliveryStatus } from '@prisma/client';
import type {
  Environment,
  PaymentEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from '@prisma/client';

import securityConfig from '@/common/config/security.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { WebhookSigner } from '@/modules/webhooks/webhook-signer';
import { WebhookEndpointService } from '@/modules/webhooks/webhook-endpoint.service';
import { WebhookDeliveryService } from '@/modules/webhooks/webhook-delivery.service';
import {
  WEBHOOK_QUEUE,
  JOB_DELIVER,
} from '@/modules/webhooks/webhooks.constants';
import type { WebhookEventPayload } from '@/modules/webhooks/webhook-payload';
import { verifyWebhookSignature } from '@/common/utils/crypto.util';

/** [jobName, jobData, jobOptions] as passed to Queue.add. */
type QueueAddCall = [string, unknown, { delay: number; jobId: string }];

const ENCRYPTION_KEY = 'f'.repeat(64);
const BUSINESS_ID = 'biz_hook_001';
const OTHER_BUSINESS_ID = 'biz_hook_999';

// ─── In-memory Prisma mock ────────────────────────────────────────────────────

class MockPrismaService {
  endpoints: WebhookEndpoint[] = [];
  deliveries: WebhookDelivery[] = [];
  events: PaymentEvent[] = [];

  private seq = 0;
  private nextId() {
    return `oid_${++this.seq}`;
  }

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
    findMany: async ({ where }: { where: Record<string, any> }) =>
      this.endpoints.filter((e) => {
        if (where.businessId && e.businessId !== where.businessId) return false;
        if (where.environment && e.environment !== where.environment)
          return false;
        if (where.active !== undefined && e.active !== where.active)
          return false;
        if (where.events?.has && !e.events.includes(where.events.has))
          return false;
        return true;
      }),
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.endpoints.find((e) => e.id === where.id) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.endpoints.find((e) =>
        Object.entries(where).every(
          ([field, value]) => (e as Record<string, unknown>)[field] === value,
        ),
      ) ?? null,
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
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const duplicate = this.deliveries.some(
        (d) => d.endpointId === data.endpointId && d.eventId === data.eventId,
      );
      if (duplicate) {
        throw Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        });
      }
      const row = {
        id: this.nextId(),
        attemptCount: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        responseStatus: null,
        responseBody: null,
        deliveredAt: null,
        createdAt: new Date(),
        ...data,
      } as unknown as WebhookDelivery;
      this.deliveries.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.deliveries.find((d) => d.id === where.id) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.deliveries.find((d) =>
        Object.entries(where).every(
          ([field, value]) => (d as Record<string, unknown>)[field] === value,
        ),
      ) ?? null,
    findMany: async ({
      where,
      take,
    }: {
      where: Record<string, any>;
      take?: number;
    }) => {
      const rows = this.deliveries
        .filter((d) => {
          if (where.endpointId && d.endpointId !== where.endpointId)
            return false;
          if (where.businessId && d.businessId !== where.businessId)
            return false;
          if (where.status && d.status !== where.status) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return take ? rows.slice(0, take) : rows;
    },
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

  readonly paymentEvent = {
    findUnique: async ({
      where,
    }: {
      where: { id?: string; publicId?: string };
    }) =>
      this.events.find((e) =>
        where.id ? e.id === where.id : e.publicId === where.publicId,
      ) ?? null,
  };

  seedEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
    const createdAt = new Date('2026-08-03T12:31:10.000Z');
    const event = {
      id: this.nextId(),
      publicId: `evt_seed_${this.seq}`,
      businessId: BUSINESS_ID,
      paymentId: 'pay_internal_1',
      type: 'payment.completed',
      createdAt,
      data: {
        publicId: 'pay_01JABC123',
        businessId: BUSINESS_ID,
        environment: 'test',
        status: 'completed',
        amount: '100.00',
        currency: 'USDC',
        description: 'Order ORD123',
        customerId: 'cus_01JABC456',
        metadata: { order_id: 'ORD123' },
        checkoutUrl: 'https://pay.hypertron.xyz/pay/pay_01JABC123',
        linkMemo: 'hpl_abc',
        destinationAddress: 'GDEST',
        payerAddress: 'GPAYER',
        transactionHash: 'a1b2c3',
        failureCode: null,
        failureMessage: null,
        expiresAt: null,
        paidAt: '2026-08-03T12:31:00.000Z',
        completedAt: '2026-08-03T12:31:10.000Z',
        canceledAt: null,
        createdAt: '2026-08-03T12:30:00.000Z',
        updatedAt: '2026-08-03T12:31:10.000Z',
      },
      ...overrides,
    };

    this.events.push(event);
    return event;
  }

  async $connect() {}
  async $disconnect() {}
}

// ─── Fetch mock ───────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let fetchCalls: FetchCall[] = [];

function mockFetchResponse(status: number, body = 'ok') {
  (global.fetch as jest.Mock).mockImplementation(
    async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      fetchCalls.push({ url, headers: init.headers, body: init.body });
      return { status, text: async () => body };
    },
  );
}

function mockFetchNetworkError(message = 'ECONNREFUSED') {
  (global.fetch as jest.Mock).mockImplementation(async () => {
    throw new Error(message);
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Webhook delivery (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: MockPrismaService;
  let deliveries: WebhookDeliveryService;
  let endpoints: WebhookEndpointService;
  let queue: { add: jest.Mock };

  /** Options of the nth Queue.add call, typed for assertions. */
  const jobOptions = (index = 0): QueueAddCall[2] =>
    (queue.add.mock.calls[index] as QueueAddCall)[2];

  const sentPayload = (index = 0): WebhookEventPayload =>
    JSON.parse(fetchCalls[index].body) as WebhookEventPayload;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
    prisma = new MockPrismaService();
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    fetchCalls = [];
    global.fetch = jest.fn();
    mockFetchResponse(200);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [securityConfig],
          ignoreEnvFile: true,
        }),
      ],
      providers: [
        WebhookSigner,
        WebhookEndpointService,
        WebhookDeliveryService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(WEBHOOK_QUEUE), useValue: queue },
      ],
    }).compile();

    deliveries = moduleRef.get(WebhookDeliveryService);
    endpoints = moduleRef.get(WebhookEndpointService);
  });

  afterEach(async () => {
    await moduleRef.close();
    jest.restoreAllMocks();
  });

  async function seedEndpoint(
    overrides: {
      businessId?: string;
      environment?: Environment;
      events?: string[];
      active?: boolean;
      url?: string;
    } = {},
  ) {
    const created = await endpoints.create({
      businessId: overrides.businessId ?? BUSINESS_ID,
      environment: overrides.environment ?? 'test',
      events: overrides.events ?? ['payment.completed'],
      url: overrides.url ?? 'https://merchant.example.com/hooks',
    });

    if (overrides.active === false) {
      await endpoints.update(
        created.endpoint.publicId,
        created.endpoint.businessId,
        {
          active: false,
        },
      );
    }
    return created;
  }

  // ─── Fan-out ────────────────────────────────────────────────────────────────

  describe('fan-out', () => {
    it('creates one pending delivery per subscribed endpoint', async () => {
      await seedEndpoint();
      await seedEndpoint({ url: 'https://merchant.example.com/hooks-2' });
      const event = prisma.seedEvent();

      const result = await deliveries.enqueueDeliveries(event);

      expect(result.created).toBe(2);
      expect(prisma.deliveries).toHaveLength(2);
      expect(prisma.deliveries[0].status).toBe(DeliveryStatus.pending);
      expect(prisma.deliveries[0].eventId).toBe(event.publicId);
      expect(prisma.deliveries[0].publicId).toMatch(/^whd_/);
    });

    it('enqueues the first attempt with no delay', async () => {
      await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect((queue.add.mock.calls[0] as QueueAddCall)[0]).toBe(JOB_DELIVER);
      expect(jobOptions().delay).toBe(0);
      expect(jobOptions().jobId).toMatch(/^whd_/);
    });

    it('skips endpoints not subscribed to the event type', async () => {
      await seedEndpoint({ events: ['payment.failed'] });

      const result = await deliveries.enqueueDeliveries(prisma.seedEvent());

      expect(result.created).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('skips inactive endpoints', async () => {
      await seedEndpoint({ active: false });

      expect(
        (await deliveries.enqueueDeliveries(prisma.seedEvent())).created,
      ).toBe(0);
    });

    it('skips endpoints in the other environment', async () => {
      await seedEndpoint({ environment: 'live' as Environment });

      expect(
        (await deliveries.enqueueDeliveries(prisma.seedEvent())).created,
      ).toBe(0);
    });

    it('never delivers another merchant events', async () => {
      await seedEndpoint({ businessId: OTHER_BUSINESS_ID });

      expect(
        (await deliveries.enqueueDeliveries(prisma.seedEvent())).created,
      ).toBe(0);
    });

    it('is idempotent — a replayed fan-out creates no duplicate delivery', async () => {
      await seedEndpoint();
      const event = prisma.seedEvent();

      await deliveries.enqueueDeliveries(event);
      const replay = await deliveries.enqueueDeliveries(event);

      expect(replay.created).toBe(0);
      expect(prisma.deliveries).toHaveLength(1);
    });

    it('fanoutEvent resolves the event by internal id', async () => {
      await seedEndpoint();
      const event = prisma.seedEvent();

      expect((await deliveries.fanoutEvent(event.id)).created).toBe(1);
    });

    it('fanoutEvent is a no-op for an unknown event', async () => {
      expect((await deliveries.fanoutEvent('missing')).created).toBe(0);
    });
  });

  // ─── Successful delivery ────────────────────────────────────────────────────

  describe('successful delivery', () => {
    it('marks the delivery delivered and records the response', async () => {
      await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      mockFetchResponse(202, 'accepted');

      const outcome = await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const delivery = prisma.deliveries[0];
      expect(outcome).toBe('delivered');
      expect(delivery.status).toBe(DeliveryStatus.delivered);
      expect(delivery.attemptCount).toBe(1);
      expect(delivery.responseStatus).toBe(202);
      expect(delivery.responseBody).toBe('accepted');
      expect(delivery.deliveredAt).toBeInstanceOf(Date);
      expect(delivery.nextAttemptAt).toBeNull();
    });

    it('posts the immutable event snapshot as the payload', async () => {
      await seedEndpoint();
      const event = prisma.seedEvent();
      await deliveries.enqueueDeliveries(event);

      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const payload = sentPayload();
      expect(payload.id).toBe(event.publicId);
      expect(payload.object).toBe('event');
      expect(payload.type).toBe('payment.completed');
      expect(payload.api_version).toBe('v1');
      expect(payload.environment).toBe('test');
      expect(payload.data.object.id).toBe('pay_01JABC123');
      expect(payload.data.object.amount).toBe('100.00');
      expect(payload.data.object.transaction_hash).toBe('a1b2c3');
    });

    it('sends signature, event id, and delivery id headers', async () => {
      await seedEndpoint();
      const event = prisma.seedEvent();
      await deliveries.enqueueDeliveries(event);

      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const { headers } = fetchCalls[0];
      expect(headers['Hypertron-Event-Id']).toBe(event.publicId);
      expect(headers['Hypertron-Delivery-Id']).toBe(
        prisma.deliveries[0].publicId,
      );
      expect(headers['Hypertron-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it('produces a signature the merchant can verify over the raw body', async () => {
      const { signingSecret } = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());

      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const { headers, body } = fetchCalls[0];
      expect(
        verifyWebhookSignature(
          headers['Hypertron-Signature'],
          signingSecret,
          body,
        ),
      ).toBe(true);
    });

    it('signs with the rotated secret after rotation', async () => {
      const created = await seedEndpoint();
      const rotated = await endpoints.rotateSecret(
        created.endpoint.publicId,
        BUSINESS_ID,
      );
      await deliveries.enqueueDeliveries(prisma.seedEvent());

      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const { headers, body } = fetchCalls[0];
      expect(
        verifyWebhookSignature(
          headers['Hypertron-Signature'],
          rotated.signingSecret,
          body,
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(
          headers['Hypertron-Signature'],
          created.signingSecret,
          body,
        ),
      ).toBe(false);
    });

    it('truncates stored response bodies to 2 KB', async () => {
      await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      mockFetchResponse(200, 'x'.repeat(5000));

      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      expect(prisma.deliveries[0].responseBody).toHaveLength(2048);
    });

    it('skips a delivery that is no longer pending', async () => {
      await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const outcome = await deliveries.attemptDelivery(prisma.deliveries[0].id);

      expect(outcome).toBe('skipped');
      expect(prisma.deliveries[0].attemptCount).toBe(1);
    });
  });

  // ─── Retries ────────────────────────────────────────────────────────────────

  describe('retries', () => {
    async function seedPendingDelivery(attemptCount = 0) {
      await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      queue.add.mockClear();
      prisma.deliveries[0].attemptCount = attemptCount;
      return prisma.deliveries[0];
    }

    it('schedules the second attempt 30s after a 500', async () => {
      const delivery = await seedPendingDelivery();
      mockFetchResponse(500, 'boom');

      const outcome = await deliveries.attemptDelivery(delivery.id);

      expect(outcome).toBe('retry_scheduled');
      expect(delivery.status).toBe(DeliveryStatus.pending);
      expect(delivery.attemptCount).toBe(1);
      expect(delivery.responseStatus).toBe(500);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(jobOptions().delay).toBe(30_000);
      expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('uses a distinct job id per retry', async () => {
      const delivery = await seedPendingDelivery();
      mockFetchResponse(503);

      await deliveries.attemptDelivery(delivery.id);

      expect(jobOptions().jobId).toBe(`${delivery.publicId}_r1`);
    });

    it('retries 429 responses', async () => {
      const delivery = await seedPendingDelivery();
      mockFetchResponse(429, 'slow down');

      expect(await deliveries.attemptDelivery(delivery.id)).toBe(
        'retry_scheduled',
      );
    });

    it('retries network errors with no HTTP status', async () => {
      const delivery = await seedPendingDelivery();
      mockFetchNetworkError('socket hang up');

      const outcome = await deliveries.attemptDelivery(delivery.id);

      expect(outcome).toBe('retry_scheduled');
      expect(delivery.responseStatus).toBeNull();
      expect(delivery.responseBody).toBe('socket hang up');
    });

    it('follows the escalating delay schedule', async () => {
      const expected = [
        30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
      ];

      for (const [index, delay] of expected.entries()) {
        const delivery = await seedPendingDelivery(index);
        mockFetchResponse(500);

        await deliveries.attemptDelivery(delivery.id);

        expect(jobOptions().delay).toBe(delay);
        prisma.deliveries = [];
        prisma.endpoints = [];
        prisma.events = [];
      }
    });

    it('fails permanently after the seventh attempt', async () => {
      const delivery = await seedPendingDelivery(6);
      mockFetchResponse(500, 'still broken');

      const outcome = await deliveries.attemptDelivery(delivery.id);

      expect(outcome).toBe('failed');
      expect(delivery.status).toBe(DeliveryStatus.failed);
      expect(delivery.attemptCount).toBe(7);
      expect(delivery.nextAttemptAt).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails immediately on a non-retryable 4xx', async () => {
      const delivery = await seedPendingDelivery();
      mockFetchResponse(400, 'bad payload');

      const outcome = await deliveries.attemptDelivery(delivery.id);

      expect(outcome).toBe('failed');
      expect(delivery.status).toBe(DeliveryStatus.failed);
      expect(delivery.attemptCount).toBe(1);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails the delivery when the endpoint was disabled meanwhile', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await endpoints.update(created.endpoint.publicId, BUSINESS_ID, {
        active: false,
      });

      const outcome = await deliveries.attemptDelivery(prisma.deliveries[0].id);

      expect(outcome).toBe('failed');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('restarts the schedule on a manual retry', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      const delivery = prisma.deliveries[0];
      mockFetchResponse(500);
      await deliveries.attemptDelivery(delivery.id);
      queue.add.mockClear();

      const retried = await deliveries.retryDelivery(
        created.endpoint.publicId,
        delivery.publicId,
        BUSINESS_ID,
      );

      expect(retried.status).toBe(DeliveryStatus.pending);
      expect(retried.attemptCount).toBe(0);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(jobOptions().delay).toBe(0);
    });

    it('refuses to retry an already delivered webhook', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      await expect(
        deliveries.retryDelivery(
          created.endpoint.publicId,
          prisma.deliveries[0].publicId,
          BUSINESS_ID,
        ),
      ).rejects.toMatchObject({
        payload: { code: 'delivery_already_delivered' },
      });
    });
  });

  // ─── Test deliveries ────────────────────────────────────────────────────────

  describe('test delivery', () => {
    it('sends a synthetic payment.completed without storing anything', async () => {
      const created = await seedEndpoint();

      const result = await deliveries.sendTest(
        created.endpoint.publicId,
        BUSINESS_ID,
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(prisma.deliveries).toHaveLength(0);

      const payload = sentPayload();
      expect(payload.type).toBe('payment.completed');
      expect(payload.data.object.object).toBe('payment');
    });

    it('signs the test payload with the endpoint secret', async () => {
      const created = await seedEndpoint();

      await deliveries.sendTest(created.endpoint.publicId, BUSINESS_ID);

      const { headers, body } = fetchCalls[0];
      expect(
        verifyWebhookSignature(
          headers['Hypertron-Signature'],
          created.signingSecret,
          body,
        ),
      ).toBe(true);
    });

    it('reports transport failures instead of throwing', async () => {
      const created = await seedEndpoint();
      mockFetchNetworkError('dns failure');

      const result = await deliveries.sendTest(
        created.endpoint.publicId,
        BUSINESS_ID,
      );

      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toBe('dns failure');
    });

    it('404s for an endpoint owned by another merchant', async () => {
      const created = await seedEndpoint({ businessId: OTHER_BUSINESS_ID });

      await expect(
        deliveries.sendTest(created.endpoint.publicId, BUSINESS_ID),
      ).rejects.toMatchObject({
        payload: {
          type: 'resource_missing',
          message: expect.stringContaining('No such webhook_endpoint'),
        },
      });
    });
  });

  // ─── Delivery log ───────────────────────────────────────────────────────────

  describe('delivery log', () => {
    it('lists deliveries for the endpoint with pagination metadata', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await deliveries.enqueueDeliveries(prisma.seedEvent());

      const { page } = await deliveries.listDeliveries(
        created.endpoint.publicId,
        BUSINESS_ID,
        { limit: 25 },
      );

      expect(page.data).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('reports has_more and a cursor when the page is full', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await deliveries.enqueueDeliveries(prisma.seedEvent());

      const { page } = await deliveries.listDeliveries(
        created.endpoint.publicId,
        BUSINESS_ID,
        { limit: 1 },
      );

      expect(page.data).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('filters by delivery status', async () => {
      const created = await seedEndpoint();
      await deliveries.enqueueDeliveries(prisma.seedEvent());
      await deliveries.attemptDelivery(prisma.deliveries[0].id);

      const { page } = await deliveries.listDeliveries(
        created.endpoint.publicId,
        BUSINESS_ID,
        { limit: 25, status: DeliveryStatus.failed },
      );

      expect(page.data).toHaveLength(0);
    });
  });
});
