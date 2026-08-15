/**
 * Shared OpenAPI DocumentBuilder used by runtime /docs and scripts/generate-openapi.
 */

import { DocumentBuilder } from '@nestjs/swagger';

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Hypertron Payments API')
    .setDescription(
      'Production-grade stablecoin payment gateway API (HyperTone). ' +
        'Public merchant API under `/v1/*` (API key auth). ' +
        'Dashboard control-plane under `/api/developer/*` (Freighter session cookie). ' +
        'Contract reference: Payments_API_v1_Schema.md.',
    )
    .setVersion('1.0.0')
    .addServer('http://localhost:3000', 'Local')
    .addServer('https://api.hypertron.xyz', 'Production')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'sk_test_... / sk_live_...',
        description: 'Secret API key for /v1 routes',
      },
      'ApiKey',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'ht_dashboard',
        description:
          'Freighter session cookie from hypertron-core-backend (HMAC AUTH_SECRET)',
      },
      'SessionCookie',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Idempotency-Key',
        description: 'Required for POST /v1/payments',
      },
      'IdempotencyKey',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Request-Id',
        description: 'Optional client correlation id',
      },
      'RequestId',
    )
    .addTag('Payments', 'Create, read, list, and cancel payments')
    .addTag('Customers', 'Merchant-scoped customer records')
    .addTag('Checkout Links', 'Public hosted-checkout lookup for /pay/cl_…')
    .addTag('Developer', 'Dashboard control-plane: API keys and webhooks')
    .addTag('Health', 'Health and readiness checks')
    .build();
}
