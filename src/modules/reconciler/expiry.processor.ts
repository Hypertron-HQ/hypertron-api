/**
 * ExpiryProcessor — BullMQ cron every minute for payment expiry (Plan §11.4).
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ReconcilerService } from './reconciler.service';
import { EXPIRY_QUEUE, JOB_EXPIRE_OVERDUE } from './reconciler.constants';

@Processor(EXPIRY_QUEUE, {
  concurrency: 1,
})
export class ExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(ExpiryProcessor.name);

  constructor(private readonly reconciler: ReconcilerService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== JOB_EXPIRE_OVERDUE) {
      this.logger.warn({ name: job.name }, 'Unknown expiry job');
      return null;
    }
    return { expired: await this.reconciler.expireOverduePayments() };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      'Expiry job failed',
    );
  }
}
