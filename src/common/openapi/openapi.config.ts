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
        '## 🎯 Quick Start Guide\n\n' +
        '### Step 1: Get Your API Key\n' +
        '1. Authenticate with Freighter wallet on the dashboard\n' +
        '2. Navigate to **Developer → API Keys**\n' +
        '3. Click **"Create API Key"**\n' +
        '4. Copy the `secret_key` (starts with `sk_test_` or `sk_live_`)\n' +
        '5. Store it securely - **you can only see it once!**\n\n' +
        '### Step 2: Authenticate Your Requests\n' +
        'Click the **🔓 Authorize** button at the top right of this page:\n' +
        '1. Select **"ApiKey (http, Bearer)"**\n' +
        '2. Enter: `sk_test_your_api_key_here`\n' +
        '3. Click **"Authorize"**\n' +
        '4. Click **"Close"**\n\n' +
        '### Step 3: Try Your First API Call\n' +
        '1. Scroll down to **"💳 Payments"** section\n' +
        '2. Click on **"POST /v1/payments"**\n' +
        '3. Click **"Try it out"**\n' +
        '4. Modify the example request (change email, amount, etc.)\n' +
        '5. Click **"Execute"**\n' +
        '6. See the response below with your `checkout_url`!\n\n' +
        '## 🔐 Authentication Methods\n\n' +
        '### 1️⃣ Merchant API (`/v1/*`) - Bearer Token\n' +
        '```bash\n' +
        'curl -X POST https://hypertron-api.onrender.com/v1/payments \\\n' +
        '  -H "Authorization: Bearer sk_test_xxxxx" \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        '  -H "Idempotency-Key: unique-key-123" \\\n' +
        '  -d \'{"amount": "10.00", "currency": "USDC", "description": "Test"}\'\n' +
        '```\n\n' +
        '### 2️⃣ Dashboard API (`/api/developer/*`) - Session Cookie\n' +
        'Automatically set after Freighter wallet authentication.\n' +
        '```bash\n' +
        'curl https://hypertron-api.onrender.com/api/developer/api-keys \\\n' +
        '  -H "Cookie: ht_dashboard=your_session_cookie"\n' +
        '```\n\n' +
        '### 3️⃣ Internal API (`/internal/*`) - Service Token\n' +
        'For service-to-service communication only.\n' +
        '```bash\n' +
        'curl -X PUT https://hypertron-api.onrender.com/internal/merchant-settings \\\n' +
        '  -H "X-Internal-Token: your_token"\n' +
        '```\n\n' +
        '## 📝 Key Features\n\n' +
        '✅ **Payments**: Create, list, retrieve, and cancel USDC payments\n' +
        '✅ **Customers**: Manage customer records and payment history\n' +
        '✅ **Checkout Links**: Generate hosted payment pages\n' +
        '✅ **Webhooks**: Real-time event notifications (payment.completed, payment.failed)\n' +
        '✅ **API Keys**: Secure credential management with rotation\n' +
        '✅ **Idempotency**: Safe retry mechanism prevents duplicate payments\n\n' +
        '## 🌐 Environments\n\n' +
        '| Environment | API Keys | Purpose |\n' +
        '|-------------|----------|----------|\n' +
        '| **Test** | `sk_test_...` | Development and testing |\n' +
        '| **Live** | `sk_live_...` | Production payments |\n\n' +
        '## � Example: Complete Payment Flow\n\n' +
        '```bash\n' +
        '# 1. Create a payment\n' +
        'curl -X POST https://hypertron-api.onrender.com/v1/payments \\\n' +
        '  -H "Authorization: Bearer sk_test_xxxxx" \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        '  -H "Idempotency-Key: payment-$(date +%s)" \\\n' +
        '  -d \'{\n' +
        '    "amount": "25.00",\n' +
        '    "currency": "USDC",\n' +
        '    "description": "Premium subscription",\n' +
        '    "customer_email": "user@example.com",\n' +
        '    "customer_name": "John Doe",\n' +
        '    "metadata": {"order_id": "12345"}\n' +
        '  }\'\n\n' +
        '# 2. Response includes checkout_url\n' +
        '# {\n' +
        '#   "id": "pay_xxxxx",\n' +
        '#   "checkout_url": "https://pay.hypertron.xyz/cl_xxxxx",\n' +
        '#   ...\n' +
        '# }\n\n' +
        '# 3. Send customer to checkout_url\n' +
        '# 4. Customer completes payment with Stellar wallet\n' +
        '# 5. Receive webhook notification at your endpoint\n' +
        '```\n\n' +
        '## 🔗 Useful Resources\n\n' +
        '- **API Base URL**: https://hypertron-api.onrender.com\n' +
        '- **Interactive Docs**: https://hypertron-api.onrender.com/docs (this page)\n' +
        '- **Health Check**: https://hypertron-api.onrender.com/health\n' +
        '- **Metrics**: https://hypertron-api.onrender.com/metrics\n\n' +
        '## ⚡ Rate Limits\n\n' +
        '- Payment Creation: 60 requests/minute\n' +
        '- Read Operations: 300 requests/minute\n' +
        '- Dashboard Operations: 120 requests/minute\n\n' +
        '## 🐛 Need Help?\n\n' +
        '- Check response error codes and messages\n' +
        '- Use `X-Request-Id` header for support inquiries\n' +
        '- All requests return detailed error information\n\n',
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
