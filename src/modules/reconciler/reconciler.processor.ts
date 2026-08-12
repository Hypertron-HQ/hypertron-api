/**
 * ReconcilerProcessor — BullMQ worker for Horizon reconciliation.
 *
 * Jobs:
 *  - poll-open-payments (cron every 30s)
 *  - finality-check (delayed per payment)
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ReconcilerService } from './reconciler.service';
import {
  RECONCILER_QUEUE,
  JOB_POLL_OPEN,
  JOB_FINALITY_CHECK,
  type FinalityCheckJob,
} from './reconciler.constants';

@Processor(RECONCILER_QUEUE, {
  concurrency: 1,
})
export class ReconcilerProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconcilerProcessor.name);

  constructor(private readonly reconciler: ReconcilerService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_POLL_OPEN:
        return this.reconciler.pollOpenPayments();
      case JOB_FINALITY_CHECK: {
        const data = job.data as FinalityCheckJob;
        return this.reconciler.finalizePayment(data.paymentInternalId);
      }
      default:
        this.logger.warn({ name: job.name }, 'Unknown reconciler job');
        return null;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        err: err.message,
      },
      'Reconciler job failed',
    );
  }
}
