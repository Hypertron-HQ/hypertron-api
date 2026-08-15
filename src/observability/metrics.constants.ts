/**
 * Prometheus metrics for HyperTone Payments API (Plan §17.2).
 */

export const METRIC_PAYMENTS_CREATED = 'payments_created_total';
export const METRIC_PAYMENTS_COMPLETED = 'payments_completed_total';
export const METRIC_PAYMENTS_FAILED = 'payments_failed_total';
export const METRIC_PAYMENT_COMPLETION_LATENCY =
  'payment_completion_latency_seconds';
export const METRIC_RECONCILIATION_ERRORS = 'reconciliation_errors_total';
export const METRIC_WEBHOOK_DELIVERIES = 'webhook_deliveries_total';
export const METRIC_API_REQUESTS = 'api_requests_total';
export const METRIC_API_REQUEST_DURATION = 'api_request_duration_seconds';
export const METRIC_RATE_LIMIT_HITS = 'rate_limit_hits_total';
