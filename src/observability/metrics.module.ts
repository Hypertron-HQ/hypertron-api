/**
 * MetricsModule — Prometheus registry + /metrics endpoint.
 */

import { Global, Module } from '@nestjs/common';
import {
  makeCounterProvider,
  makeHistogramProvider,
  PrometheusModule,
} from '@willsoto/nestjs-prometheus';

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
import { MetricsService } from './metrics.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

const metricProviders = [
  makeCounterProvider({
    name: METRIC_PAYMENTS_CREATED,
    help: 'Total payments created',
    labelNames: ['environment', 'currency'],
  }),
  makeCounterProvider({
    name: METRIC_PAYMENTS_COMPLETED,
    help: 'Total payments completed',
    labelNames: ['environment', 'currency'],
  }),
  makeCounterProvider({
    name: METRIC_PAYMENTS_FAILED,
    help: 'Total payments failed',
    labelNames: ['environment', 'failure_code'],
  }),
  makeHistogramProvider({
    name: METRIC_PAYMENT_COMPLETION_LATENCY,
    help: 'Seconds from payment creation to completion',
    labelNames: ['environment'],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  }),
  makeCounterProvider({
    name: METRIC_RECONCILIATION_ERRORS,
    help: 'Reconciliation verification / processing errors',
    labelNames: ['error_type'],
  }),
  makeCounterProvider({
    name: METRIC_WEBHOOK_DELIVERIES,
    help: 'Webhook delivery outcomes',
    labelNames: ['status', 'attempt'],
  }),
  makeCounterProvider({
    name: METRIC_API_REQUESTS,
    help: 'HTTP API requests',
    labelNames: ['method', 'path', 'status'],
  }),
  makeHistogramProvider({
    name: METRIC_API_REQUEST_DURATION,
    help: 'HTTP API request duration in seconds',
    labelNames: ['method', 'path'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }),
  makeCounterProvider({
    name: METRIC_RATE_LIMIT_HITS,
    help: 'Rate limit rejections',
    labelNames: ['endpoint_group'],
  }),
];

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [...metricProviders, MetricsService, HttpMetricsInterceptor],
  exports: [MetricsService, HttpMetricsInterceptor, PrometheusModule],
})
export class MetricsModule {}
