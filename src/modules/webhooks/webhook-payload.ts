/**
 * Webhook payload construction (spec §9.2).
 *
 * The payload is built from the immutable `PaymentEvent.data` snapshot, never
 * from a live payment read, so a redelivery carries exactly the state that was
 * captured when the event was emitted.
 */

import type { Payment, PaymentEvent } from '@prisma/client';

import {
  toPaymentResponse,
  type PaymentResponseDto,
} from '@/modules/payments/dto/payment-response.dto';
import { WEBHOOK_API_VERSION } from './webhooks.constants';

export interface WebhookEventPayload {
  id: string;
  object: 'event';
  type: string;
  api_version: string;
  environment: string;
  created_at: string;
  data: { object: PaymentResponseDto };
}

/**
 * Snapshots round-trip through JSON/BSON, so timestamps come back as either
 * Date objects or ISO strings depending on the driver. Normalise before the
 * shared payment mapper touches them.
 */
function coerceDate(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const DATE_FIELDS = [
  'expiresAt',
  'paidAt',
  'completedAt',
  'canceledAt',
  'createdAt',
  'updatedAt',
] as const;

export function snapshotToPayment(
  snapshot: Record<string, unknown>,
  fallbackDate: Date,
): Payment {
  const normalised: Record<string, unknown> = { ...snapshot };

  for (const field of DATE_FIELDS) {
    normalised[field] = coerceDate(normalised[field]);
  }
  normalised.createdAt ??= fallbackDate;
  normalised.updatedAt ??= fallbackDate;

  return normalised as unknown as Payment;
}

/** Environment the payment was created in, defaulting to the safer `test`. */
export function environmentFromSnapshot(
  snapshot: Record<string, unknown>,
): string {
  return typeof snapshot.environment === 'string'
    ? snapshot.environment
    : 'test';
}

export function buildWebhookPayload(event: PaymentEvent): WebhookEventPayload {
  const snapshot = (event.data ?? {}) as Record<string, unknown>;
  const payment = snapshotToPayment(snapshot, event.createdAt);

  return {
    id: event.publicId,
    object: 'event',
    type: event.type,
    api_version: WEBHOOK_API_VERSION,
    environment: environmentFromSnapshot(snapshot),
    created_at: event.createdAt.toISOString(),
    data: { object: toPaymentResponse(payment) },
  };
}

/**
 * Synthetic `payment.completed` payload for `POST .../:id/test`.
 * No PaymentEvent row is created — this never enters the event store.
 */
export function buildTestPayload(
  environment: string,
  businessId: string,
): WebhookEventPayload {
  const now = new Date();
  const payment: Payment = {
    publicId: 'pay_00000000000000000000000000',
    businessId,
    environment,
    status: 'completed',
    amount: '10.00',
    currency: 'USDC',
    description: 'Test webhook delivery',
    customerId: 'cus_00000000000000000000000000',
    metadata: { test: 'true' },
    checkoutUrl: 'https://pay.hypertron.xyz/pay/test',
    linkMemo: 'hpl_test',
    destinationAddress:
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    payerAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF',
    transactionHash: '0'.repeat(64),
    failureCode: null,
    failureMessage: null,
    expiresAt: null,
    paidAt: now,
    completedAt: now,
    canceledAt: null,
    createdAt: now,
    updatedAt: now,
  } as unknown as Payment;

  return {
    id: 'evt_00000000000000000000000000',
    object: 'event',
    type: 'payment.completed',
    api_version: WEBHOOK_API_VERSION,
    environment,
    created_at: now.toISOString(),
    data: { object: toPaymentResponse(payment) },
  };
}
