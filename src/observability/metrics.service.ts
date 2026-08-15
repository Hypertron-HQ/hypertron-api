/**
 * MetricsService — typed helpers over Prometheus counters/histograms.
 */

import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Histogram } from 'prom-client';

import {
  METRIC_API_REQUEST_DURATION,
  METRIC_API_REQUESTS,
  METRIC_PAYMENT_COMPLETION_LATENCY,
  METRIC_PAYMENTS_COMPLETED,
  METRIC_PAYMENTS_CREATED,
  METRIC_PAYMENTS_FAILED,
  METRIC_RATE_LIMIT_HITS,
  METRIC_RECONCILIATION_ERRORS,
  METRIC_WEBHOOK_DELIVERIES,
} from './metrics.constants';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(METRIC_PAYMENTS_CREATED)
    private readonly paymentsCreated: Counter<string>,
    @InjectMetric(METRIC_PAYMENTS_COMPLETED)
    private readonly paymentsCompleted: Counter<string>,
    @InjectMetric(METRIC_PAYMENTS_FAILED)
    private readonly paymentsFailed: Counter<string>,
    @InjectMetric(METRIC_PAYMENT_COMPLETION_LATENCY)
    private readonly paymentCompletionLatency: Histogram<string>,
    @InjectMetric(METRIC_RECONCILIATION_ERRORS)
    private readonly reconciliationErrors: Counter<string>,
    @InjectMetric(METRIC_WEBHOOK_DELIVERIES)
    private readonly webhookDeliveries: Counter<string>,
    @InjectMetric(METRIC_API_REQUESTS)
    private readonly apiRequests: Counter<string>,
    @InjectMetric(METRIC_API_REQUEST_DURATION)
    private readonly apiRequestDuration: Histogram<string>,
    @InjectMetric(METRIC_RATE_LIMIT_HITS)
    private readonly rateLimitHits: Counter<string>,
  ) {}

  recordPaymentCreated(environment: string, currency: string): void {
    this.paymentsCreated.inc({ environment, currency });
  }

  recordPaymentCompleted(
    environment: string,
    currency: string,
    latencySeconds?: number,
  ): void {
    this.paymentsCompleted.inc({ environment, currency });
    if (latencySeconds !== undefined && Number.isFinite(latencySeconds)) {
      this.paymentCompletionLatency.observe({ environment }, latencySeconds);
    }
  }

  recordPaymentFailed(environment: string, failureCode: string): void {
    this.paymentsFailed.inc({
      environment,
      failure_code: failureCode || 'unknown',
    });
  }

  recordReconciliationError(errorType: string): void {
    this.reconciliationErrors.inc({ error_type: errorType || 'unknown' });
  }

  recordWebhookDelivery(status: string, attempt: number): void {
    this.webhookDeliveries.inc({
      status,
      attempt: String(attempt),
    });
  }

  recordApiRequest(
    method: string,
    path: string,
    status: number,
    durationSeconds: number,
  ): void {
    const route = normalizePath(path);
    this.apiRequests.inc({
      method,
      path: route,
      status: String(status),
    });
    this.apiRequestDuration.observe({ method, path: route }, durationSeconds);
  }

  recordRateLimitHit(endpointGroup: string): void {
    this.rateLimitHits.inc({ endpoint_group: endpointGroup || 'unknown' });
  }
}

/** Collapse path params so cardinality stays bounded. */
function normalizePath(path: string): string {
  const bare = path.split('?')[0] ?? path;
  return bare
    .replace(/\/pay_[A-Z0-9]+/gi, '/:paymentId')
    .replace(/\/cus_[A-Z0-9]+/gi, '/:customerId')
    .replace(/\/key_[A-Z0-9]+/gi, '/:keyId')
    .replace(/\/we_[A-Z0-9]+/gi, '/:endpointId')
    .replace(/\/whd_[A-Z0-9]+/gi, '/:deliveryId')
    .replace(/\/evt_[A-Z0-9]+/gi, '/:eventId')
    .replace(/\/[a-f0-9]{24}\b/gi, '/:id')
    .replace(/\/[0-9a-z]{20,}\b/gi, '/:id');
}
