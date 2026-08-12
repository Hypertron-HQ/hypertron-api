/**
 * WebhooksModule — endpoint CRUD, signing, and queued delivery.
 *
 * Global so that EventsService can resolve WEBHOOK_DISPATCHER without
 * EventsModule importing this module (which would close a dependency cycle).
 * Modules that use the services directly still import it explicitly.
 */

import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { WebhookSigner } from './webhook-signer';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookProcessor } from './webhook.processor';
import { WEBHOOK_DISPATCHER } from './webhook-dispatcher';
import { workersDisabled } from '@/common/config/queue.config';
import { WEBHOOK_QUEUE } from './webhooks.constants';

const disableWorkers = workersDisabled();

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE })],
  providers: [
    WebhookSigner,
    WebhookEndpointService,
    WebhookDeliveryService,
    { provide: WEBHOOK_DISPATCHER, useExisting: WebhookDeliveryService },
    // HTTP-only pods still enqueue deliveries; only the worker is skipped.
    ...(disableWorkers ? [] : [WebhookProcessor]),
  ],
  exports: [
    WebhookSigner,
    WebhookEndpointService,
    WebhookDeliveryService,
    WEBHOOK_DISPATCHER,
  ],
})
export class WebhooksModule {}
