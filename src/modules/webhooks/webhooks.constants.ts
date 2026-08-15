/**
 * Webhook delivery constants (Plan §13).
 */

export const WEBHOOK_QUEUE = 'webhook-delivery';

export const JOB_FANOUT_EVENT = 'fanout-event';
export const JOB_DELIVER = 'deliver';

export interface FanoutEventJob {
  eventInternalId: string;
}

export interface DeliverJob {
  deliveryInternalId: string;
}

/** Version stamped into every webhook payload. */
export const WEBHOOK_API_VERSION = 'v1';

/** Per-attempt HTTP timeout (spec §9.4). */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Attempt 1 is immediate; attempts 2–7 use RETRY_DELAYS_MS. */
export const MAX_DELIVERY_ATTEMPTS = 7;

/** Response bodies are stored truncated for debugging (spec: 2 KB). */
export const RESPONSE_BODY_MAX_CHARS = 2048;

/** Delay before attempts 2..7 — 30s, 2m, 10m, 1h, 6h, 24h. */
export const RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
];

/** 4xx codes that are still worth retrying (spec §9.4). */
const RETRYABLE_CLIENT_STATUS = new Set([408, 409, 425, 429]);

export const WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'payment.pending',
  'payment.confirmed',
  'payment.completed',
  'payment.failed',
  'payment.expired',
  'payment.canceled',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Network errors and timeouts are always retryable; HTTP status decides the rest. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_CLIENT_STATUS.has(status);
}

/**
 * Delay before the next attempt, given how many attempts have already been made.
 * Returns null once the retry schedule is exhausted (delivery becomes `failed`).
 */
export function retryDelayMs(completedAttempts: number): number | null {
  if (completedAttempts < 1) return 0;
  if (completedAttempts >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[completedAttempts - 1] ?? null;
}
