/**
 * Shared OpenAPI DocumentBuilder used by runtime /docs and scripts/generate-openapi.
 */

import { DocumentBuilder } from '@nestjs/swagger';

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Hypertron Payments API')
    .setDescription(
      '# 🚀 Hypertron Payments API\n\n' +
        'Production-grade stablecoin payment gateway powered by Stellar blockchain.\n\n' +
        '## 🔐 Authentication\n\n' +
        '### Merchant API (`/v1/*`)\n' +
        'Use Bearer token authentication with your API key:\n' +
        '```\n' +
        'Authorization: Bearer sk_test_...\n' +
        '```\n\n' +
        '### Dashboard API (`/api/developer/*`)\n' +
        'Requires session cookie from Freighter wallet authentication.\n\n' +
        '## 📝 Key Features\n\n' +
        '- **Payments**: Create, list, retrieve, and cancel payments\n' +
        '- **Customers**: Manage customer records and payment history\n' +
        '- **Checkout Links**: Generate hosted payment pages\n' +
        '- **Webhooks**: Real-time event notifications\n' +
        '- **API Keys**: Secure credential management\n' +
        '- **Idempotency**: Safe retry mechanism for payment creation\n\n' +
        '## 🌐 Environments\n\n' +
        '- **Test**: Use `sk_test_...` keys for testing\n' +
        '- **Live**: Use `sk_live_...` keys for production\n\n' +
        '## 📚 Getting Started\n\n' +
        '1. Create an API key from the dashboard\n' +
        '2. Use the key in Authorization header\n' +
        '3. Create a payment with POST /v1/payments\n' +
        '4. Customer completes payment on checkout link\n' +
        '5. Receive webhook notification on completion\n\n' +
        '## 🔗 Resources\n\n' +
        '- [API Documentation](https://docs.hypertron.xyz)\n' +
        '- [Webhook Guide](https://docs.hypertron.xyz/webhooks)\n' +
        '- [Integration Examples](https://github.com/hypertron/examples)\n\n',
    )
    .setVersion('1.0.0')
    .setContact(
      'Hypertron Support',
      'https://hypertron.xyz',
      'support@hypertron.xyz',
    )
    .setLicense('Proprietary', 'https://hypertron.xyz/terms')
    .addServer('http://localhost:3000', 'Local Development')
    .addServer('https://hypertron-api.onrender.com', 'Production (Render)')
    .addServer('https://api.hypertron.xyz', 'Production (Custom Domain)')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'sk_test_... / sk_live_...',
        description:
          'Secret API key for merchant endpoints. Get your API key from the dashboard at `/api/developer/api-keys`.',
      },
      'ApiKey',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'ht_dashboard',
        description:
          'Session cookie from Freighter wallet authentication. Automatically set by the dashboard application.',
      },
      'SessionCookie',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Idempotency-Key',
        description:
          'Required for POST /v1/payments. Use a unique string (e.g., UUID) to safely retry requests without creating duplicate payments.',
      },
      'IdempotencyKey',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Request-Id',
        description:
          'Optional correlation ID for request tracing. Will be auto-generated if not provided.',
      },
      'RequestId',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Internal-Token',
        description:
          'Internal service token for service-to-service communication. Used by Core Backend.',
      },
      'InternalToken',
    )
    .addTag('Health', '🏥 Health checks and service status')
    .addTag('Payments', '💳 Create, read, list, and cancel payments')
    .addTag('Customers', '👥 Merchant-scoped customer records and history')
    .addTag('Checkout Links', '🔗 Public hosted-checkout links')
    .addTag('Developer', '🔧 Dashboard control-plane: API keys and webhooks')
    .addTag('Internal', '⚙️ Internal service-to-service endpoints')
    .build();
}
