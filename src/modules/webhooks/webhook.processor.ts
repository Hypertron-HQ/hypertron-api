/**
 * WebhookProcessor — BullMQ worker for webhook fan-out and delivery.
 *
 * Jobs:
 *  - fanout-event (one per emitted PaymentEvent)
 *  - deliver      (one per attempt; retries are re-enqueued with a delay)
 */

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  JOB_DELIVER,
  JOB_FANOUT_EVENT,
  WEBHOOK_QUEUE,
  type DeliverJob,
  type FanoutEventJob,
} from './webhooks.constants';

@Processor(WEBHOOK_QUEUE, {
  concurrency: 10,
})
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly deliveries: WebhookDeliveryService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_FANOUT_EVENT: {
        const data = job.data as FanoutEventJob;
        return this.deliveries.fanoutEvent(data.eventInternalId);
      }
      case JOB_DELIVER: {
        const data = job.data as DeliverJob;
        return this.deliveries.attemptDelivery(data.deliveryInternalId);
      }
      default:
        this.logger.warn({ name: job.name }, 'Unknown webhook job');
        return null;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      'Webhook job failed',
    );
  }
}
