/**
 * WebhookDeliveryService — fan-out, signed HTTP delivery, and retry bookkeeping
 * (Plan §13).
 *
 * Delivery is always asynchronous: emitting an event only enqueues a fan-out
 * job, so a slow or dead merchant endpoint can never block payment creation or
 * blockchain reconciliation.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DeliveryStatus } from '@prisma/client';
import type {
  Environment,
  PaymentEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { generateId, PREFIXES } from '@/common/utils/id-generator';
import { InvalidRequestException } from '@/common/exceptions/hypertron.exception';
import {
  decodeCursor,
  encodeCursor,
} from '@/modules/payments/payments.repository';

import { WebhookSigner } from './webhook-signer';
import { WebhookEndpointService } from './webhook-endpoint.service';
import {
  buildTestPayload,
  buildWebhookPayload,
  environmentFromSnapshot,
} from './webhook-payload';
import type { WebhookDispatcher } from './webhook-dispatcher';
import type { WebhookEventPayload } from './webhook-payload';
import {
  isRetryableStatus,
  retryDelayMs,
  JOB_DELIVER,
  JOB_FANOUT_EVENT,
  RESPONSE_BODY_MAX_CHARS,
  WEBHOOK_QUEUE,
  WEBHOOK_TIMEOUT_MS,
  type DeliverJob,
  type FanoutEventJob,
} from './webhooks.constants';

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
}

export type DeliveryOutcome =
  'delivered' | 'retry_scheduled' | 'failed' | 'skipped';

export interface DeliveryPage {
  data: WebhookDelivery[];
  hasMore: boolean;
  nextCursor: string | null;
}

@Injectable()
export class WebhookDeliveryService implements WebhookDispatcher {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signer: WebhookSigner,
    private readonly endpoints: WebhookEndpointService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  // ─── Dispatch (called from EventsService) ───────────────────────────────────

  async dispatchEvent(event: PaymentEvent): Promise<void> {
    const data: FanoutEventJob = { eventInternalId: event.id };
    await this.queue.add(JOB_FANOUT_EVENT, data, {
      jobId: `fanout_${event.publicId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  // ─── Fan-out ────────────────────────────────────────────────────────────────

  /**
   * Creates one WebhookDelivery per subscribed endpoint and enqueues the first
   * attempt. The `(endpointId, eventId)` unique index makes this idempotent, so
   * a replayed fan-out job never double-delivers.
   */
  async enqueueDeliveries(event: PaymentEvent): Promise<{ created: number }> {
    const snapshot = (event.data ?? {}) as Record<string, unknown>;
    const environment = environmentFromSnapshot(snapshot) as Environment;

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        businessId: event.businessId,
        environment,
        active: true,
        events: { has: event.type },
      },
    });

    let created = 0;

    for (const endpoint of endpoints) {
      const delivery = await this.createDelivery(event, endpoint);
      if (!delivery) continue;

      created += 1;
      await this.enqueueAttempt(delivery, 0);
    }

    if (created > 0) {
      this.logger.log(
        { eventId: event.publicId, type: event.type, created },
        'Webhook deliveries enqueued',
      );
    }
    return { created };
  }

  async fanoutEvent(eventInternalId: string): Promise<{ created: number }> {
    const event = await this.prisma.paymentEvent.findUnique({
      where: { id: eventInternalId },
    });

    if (!event) {
      this.logger.warn(
        { eventInternalId },
        'Fan-out skipped — event not found',
      );
      return { created: 0 };
    }
    return this.enqueueDeliveries(event);
  }

  // ─── Delivery attempt ───────────────────────────────────────────────────────

  async attemptDelivery(deliveryInternalId: string): Promise<DeliveryOutcome> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryInternalId },
    });

    if (!delivery || delivery.status !== DeliveryStatus.pending) {
      return 'skipped';
    }

    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });

    if (!endpoint || !endpoint.active) {
      await this.markFailed(delivery, {
        ok: false,
        status: null,
        body: null,
        error: 'Endpoint is inactive or no longer exists',
      });
      return 'failed';
    }

    const event = await this.prisma.paymentEvent.findUnique({
      where: { publicId: delivery.eventId },
    });

    if (!event) {
      await this.markFailed(delivery, {
        ok: false,
        status: null,
        body: null,
        error: 'Source event no longer exists',
      });
      return 'failed';
    }

    const payload = buildWebhookPayload(event);
    const result = await this.send(endpoint, payload, delivery.publicId);
    const attemptCount = delivery.attemptCount + 1;

    if (result.ok) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: DeliveryStatus.delivered,
          attemptCount,
          lastAttemptAt: new Date(),
          deliveredAt: new Date(),
          nextAttemptAt: null,
          responseStatus: result.status,
          responseBody: truncate(result.body),
        },
      });

      this.logger.log(
        {
          deliveryId: delivery.publicId,
          eventId: delivery.eventId,
          status: result.status,
          attempt: attemptCount,
        },
        'Webhook delivered',
      );
      return 'delivered';
    }

    // Network errors and timeouts (status === null) are always retryable.
    const retryable =
      result.status === null || isRetryableStatus(result.status);
    const delay = retryable ? retryDelayMs(attemptCount) : null;

    if (delay === null) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: DeliveryStatus.failed,
          attemptCount,
          lastAttemptAt: new Date(),
          nextAttemptAt: null,
          responseStatus: result.status,
          responseBody: truncate(result.body ?? result.error),
        },
      });

      this.logger.error(
        {
          deliveryId: delivery.publicId,
          eventId: delivery.eventId,
          status: result.status,
          attempt: attemptCount,
          retryable,
        },
        retryable
          ? 'Webhook delivery permanently failed — retry schedule exhausted'
          : 'Webhook delivery permanently failed — non-retryable response',
      );
      return 'failed';
    }

    const nextAttemptAt = new Date(Date.now() + delay);
    const updated = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attemptCount,
        lastAttemptAt: new Date(),
        nextAttemptAt,
        responseStatus: result.status,
        responseBody: truncate(result.body ?? result.error),
      },
    });

    await this.enqueueAttempt(updated, delay);

    this.logger.warn(
      {
        deliveryId: delivery.publicId,
        status: result.status,
        attempt: attemptCount,
        nextAttemptAt,
      },
      'Webhook delivery failed — retry scheduled',
    );
    return 'retry_scheduled';
  }

  // ─── Manual retry (dashboard) ───────────────────────────────────────────────

  async retryDelivery(
    endpointPublicId: string,
    deliveryPublicId: string,
    businessId: string,
  ): Promise<WebhookDelivery> {
    const endpoint = await this.endpoints.findOneOrThrow(
      endpointPublicId,
      businessId,
    );

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: {
        publicId: deliveryPublicId,
        businessId,
        endpointId: endpoint.id,
      },
    });

    if (!delivery) {
      throw new InvalidRequestException(
        'delivery_not_found',
        `No such webhook delivery: '${deliveryPublicId}'`,
      );
    }

    if (delivery.status === DeliveryStatus.delivered) {
      throw new InvalidRequestException(
        'delivery_already_delivered',
        'This delivery already succeeded and cannot be retried.',
      );
    }

    // A manual retry restarts the schedule from attempt 1.
    const reset = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: DeliveryStatus.pending,
        attemptCount: 0,
        nextAttemptAt: new Date(),
      },
    });

    await this.enqueueAttempt(reset, 0, `manual_${Date.now()}`);
    return reset;
  }

  // ─── Test delivery ──────────────────────────────────────────────────────────

  /**
   * Sends a synthetic `payment.completed` payload once. No PaymentEvent and no
   * WebhookDelivery row are created (Plan §13.7).
   */
  async sendTest(
    endpointPublicId: string,
    businessId: string,
  ): Promise<AttemptResult> {
    const endpoint = await this.endpoints.findOneOrThrow(
      endpointPublicId,
      businessId,
    );

    const payload = buildTestPayload(endpoint.environment, businessId);
    return this.send(endpoint, payload, generateId(PREFIXES.WEBHOOK_DELIVERY));
  }

  // ─── Delivery observability ─────────────────────────────────────────────────

  async listDeliveries(
    endpointPublicId: string,
    businessId: string,
    params: { limit: number; cursor?: string; status?: DeliveryStatus },
  ): Promise<{ endpoint: WebhookEndpoint; page: DeliveryPage }> {
    const endpoint = await this.endpoints.findOneOrThrow(
      endpointPublicId,
      businessId,
    );

    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const take = params.limit + 1;

    const rows = await this.prisma.webhookDelivery.findMany({
      where: {
        endpointId: endpoint.id,
        businessId,
        ...(params.status ? { status: params.status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });

    const hasMore = rows.length > params.limit;
    const data = hasMore ? rows.slice(0, params.limit) : rows;
    const last = data[data.length - 1];

    return {
      endpoint,
      page: {
        data,
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      },
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async createDelivery(
    event: PaymentEvent,
    endpoint: WebhookEndpoint,
  ): Promise<WebhookDelivery | null> {
    try {
      return await this.prisma.webhookDelivery.create({
        data: {
          publicId: generateId(PREFIXES.WEBHOOK_DELIVERY),
          businessId: event.businessId,
          endpointId: endpoint.id,
          eventId: event.publicId,
          status: DeliveryStatus.pending,
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // (endpointId, eventId) already delivered or in flight.
        return null;
      }
      throw err;
    }
  }

  private async enqueueAttempt(
    delivery: WebhookDelivery,
    delayMs: number,
    jobIdSuffix?: string,
  ): Promise<void> {
    const data: DeliverJob = { deliveryInternalId: delivery.id };
    const suffix =
      jobIdSuffix ??
      (delivery.attemptCount > 0 ? `r${delivery.attemptCount}` : '');

    await this.queue.add(JOB_DELIVER, data, {
      // First attempt reuses the delivery id so duplicate fan-outs collapse.
      jobId: suffix ? `${delivery.publicId}_${suffix}` : delivery.publicId,
      delay: delayMs,
      // Retries are scheduled from the delivery record, not by BullMQ, so the
      // merchant-visible attempt count stays authoritative.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }

  private async markFailed(
    delivery: WebhookDelivery,
    result: AttemptResult,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: DeliveryStatus.failed,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(),
        nextAttemptAt: null,
        responseStatus: result.status,
        responseBody: truncate(result.error ?? result.body),
      },
    });
  }

  private async send(
    endpoint: WebhookEndpoint,
    payload: WebhookEventPayload,
    deliveryPublicId: string,
  ): Promise<AttemptResult> {
    const body = JSON.stringify(payload);
    // Re-read and decrypt per attempt so a rotated secret takes effect at once.
    const secret = this.signer.decrypt(endpoint.signingSecretEncrypted);
    const headers = this.signer.buildHeaders({
      secret,
      body,
      eventId: payload.id,
      deliveryId: deliveryPublicId,
    });

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      const text = await response.text().catch(() => '');

      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        body: text,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: null, body: null, error: message };
    }
  }
}

function truncate(value: string | null): string | null {
  if (!value) return null;
  return value.length > RESPONSE_BODY_MAX_CHARS
    ? value.slice(0, RESPONSE_BODY_MAX_CHARS)
    : value;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2002';
}
