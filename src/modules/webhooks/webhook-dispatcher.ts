/**
 * Dispatch seam between EventsModule and WebhooksModule.
 *
 * EventsService depends on this token rather than on WebhookDeliveryService so
 * the event store keeps working (and stays testable) without the webhook stack
 * — see Plan §5 "the dependency graph is a DAG".
 */

import type { PaymentEvent } from '@prisma/client';

export const WEBHOOK_DISPATCHER = 'WEBHOOK_DISPATCHER';

export interface WebhookDispatcher {
  /** Enqueues webhook fan-out for an emitted payment event. Must not block. */
  dispatchEvent(event: PaymentEvent): Promise<void>;
}
