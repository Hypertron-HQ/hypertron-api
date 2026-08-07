/**
 * Prefixed ULID-based ID generator.
 *
 * Prefix map (matches Payments_API_v1_Schema.md):
 *   pay_ → Payment
 *   cus_ → Customer
 *   evt_ → PaymentEvent
 *   key_ → ApiKey
 *   we_  → WebhookEndpoint
 *   whd_ → WebhookDelivery
 *   req_ → Request ID
 */

import { ulid } from 'ulid';

/** Injection token — keeps the implementation swappable in tests. */
export const ID_GENERATOR = 'ID_GENERATOR';

export type IdGenerator = (prefix: string) => string;

export const PREFIXES = {
  PAYMENT: 'pay',
  CUSTOMER: 'cus',
  EVENT: 'evt',
  API_KEY: 'key',
  WEBHOOK_ENDPOINT: 'we',
  WEBHOOK_DELIVERY: 'whd',
  REQUEST: 'req',
} as const;

export type IdPrefix = (typeof PREFIXES)[keyof typeof PREFIXES];

/**
 * Generates a globally unique, prefixed, lexicographically sortable ID.
 *
 * Format: `<prefix>_<ULID>` — e.g. `pay_01JKZXM2FJYP3K4567890ABCDE`
 */
export function generateId(prefix: string): string {
  if (!prefix || prefix.trim().length === 0) {
    throw new Error('ID prefix must be a non-empty string');
  }
  return `${prefix}_${ulid()}`;
}

/** NestJS custom provider for DI-swappable ID generation. */
export const idGeneratorProvider = {
  provide: ID_GENERATOR,
  useFactory: (): IdGenerator => generateId,
};
