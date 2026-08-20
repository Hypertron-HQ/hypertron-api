# Hypertron API - Swagger/OpenAPI Documentation Guide

## 📖 Overview

The Hypertron API includes comprehensive Swagger/OpenAPI documentation for all endpoints, making it easy to explore, test, and integrate with the API.

---

## 🌐 Accessing Swagger UI

### Local Development
```
http://localhost:3000/docs
```

### Production (Render)
```
https://hypertron-api.onrender.com/docs
```

**Note:** Swagger UI in production requires the `SWAGGER_ENABLED=true` environment variable to be set in Render.

---

## 📥 OpenAPI Specification

### JSON Format
```
GET /docs-json
```

### YAML Format (if configured)
```
GET /docs-yaml
```

### Generate Locally
```bash
# Install dependencies
npm install

# Generate OpenAPI spec file
npx ts-node scripts/generate-openapi-spec.ts

# Output: openapi-spec.json
```

---

## 🔐 Authentication

The API supports multiple authentication methods:

### 1. **Bearer Token (Merchant API)**
For `/v1/*` endpoints:

```http
Authorization: Bearer sk_test_xxxxxxxxxxxxx
```

**Where to get:**
- Create from dashboard: POST `/api/developer/api-keys`
- Test keys start with `sk_test_`
- Live keys start with `sk_live_`

### 2. **Session Cookie (Dashboard API)**
For `/api/developer/*` endpoints:

```http
Cookie: ht_dashboard=eyJhbGc...
```

**Where to get:**
- Automatically set by Freighter wallet authentication
- Generated from Core Backend with wallet signature

### 3. **Internal Token**
For `/internal/*` endpoints:

```http
X-Internal-Token: your-internal-service-token
```

**Where to get:**
- Set in Render environment variables
- Used for service-to-service communication

---

## 📚 API Endpoints by Category

### 🏥 Health
Monitor service health and status

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | None | Service identity |
| `/health` | GET | None | Health check with database status |
| `/metrics` | GET | None | Prometheus metrics |

**Example:**
```bash
curl https://hypertron-api.onrender.com/health
```

### 💳 Payments
Create and manage payments

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/payments` | POST | Bearer | Create a new payment |
| `/v1/payments` | GET | Bearer | List all payments |
| `/v1/payments/:id` | GET | Bearer | Get payment details |
| `/v1/payments/:id/cancel` | POST | Bearer | Cancel a payment |
| `/v1/payments/:id/events` | GET | Bearer | List payment events |

**Example: Create Payment**
```bash
curl -X POST https://hypertron-api.onrender.com/v1/payments \
  -H "Authorization: Bearer sk_test_xxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{
    "amount": "10.00",
    "currency": "USDC",
    "description": "Test payment",
    "customer_email": "customer@example.com"
  }'
```

**Response:**
```json
{
  "id": "pay_xxxxx",
  "amount": "10.00",
  "currency": "USDC",
  "status": "created",
  "checkout_url": "https://pay.hypertron.xyz/cl_xxxxx",
  "created_at": "2026-08-17T00:00:00Z"
}
```

### 👥 Customers
Manage customer records

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/customers` | GET | Bearer | List customers (merchant API) |
| `/v1/customers/:id` | GET | Bearer | Get customer details (merchant API) |
| `/api/developer/customers` | GET | Cookie | List customers (dashboard) |
| `/api/developer/customers/:id` | GET | Cookie | Get customer details (dashboard) |

**Example:**
```bash
curl https://hypertron-api.onrender.com/v1/customers \
  -H "Authorization: Bearer sk_test_xxx"
```

### 🔗 Checkout Links
Public hosted payment pages

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/checkout-links/:publicId` | GET | None | Get checkout link details (public) |

**Example:**
```bash
curl https://hypertron-api.onrender.com/v1/checkout-links/cl_xxxxx
```

### 🔧 Developer (Dashboard)
Manage API keys and webhooks

#### API Keys
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/developer/api-keys` | GET | Cookie | List API keys |
| `/api/developer/api-keys` | POST | Cookie | Create API key |
| `/api/developer/api-keys/:id/rotate` | POST | Cookie | Rotate API key |
| `/api/developer/api-keys/:id/revoke` | POST | Cookie | Revoke API key |

**Example: Create API Key**
```bash
curl -X POST https://hypertron-api.onrender.com/api/developer/api-keys \
  -H "Cookie: ht_dashboard=xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production API Key",
    "environment": "live"
  }'
```

#### Webhooks
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/developer/webhook-endpoints` | GET | Cookie | List webhook endpoints |
| `/api/developer/webhook-endpoints` | POST | Cookie | Create webhook endpoint |
| `/api/developer/webhook-endpoints/:id` | PATCH | Cookie | Update webhook endpoint |
| `/api/developer/webhook-endpoints/:id/rotate-secret` | POST | Cookie | Rotate signing secret |
| `/api/developer/webhook-endpoints/:id/test` | POST | Cookie | Send test webhook |
| `/api/developer/webhook-endpoints/:id/deliveries` | GET | Cookie | List webhook deliveries |
| `/api/developer/webhook-endpoints/:id/deliveries/:deliveryId/retry` | POST | Cookie | Retry failed delivery |
| `/api/developer/webhook-endpoints/:id` | DELETE | Cookie | Delete webhook endpoint |

**Example: Create Webhook**
```bash
curl -X POST https://hypertron-api.onrender.com/api/developer/webhook-endpoints \
  -H "Cookie: ht_dashboard=xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhooks",
    "environment": "test",
    "events": ["payment.completed", "payment.failed"],
    "description": "Production webhook"
  }'
```

### ⚙️ Internal
Service-to-service endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/internal/merchant-settings` | PUT | Internal Token | Sync merchant settings from Core Backend |

**Example:**
```bash
curl -X PUT https://hypertron-api.onrender.com/internal/merchant-settings \
  -H "X-Internal-Token: your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_12345",
    "walletAddress": "GABC123...",
    "receiveAddress": "GXYZ789..."
  }'
```

---

## 🎯 Common Use Cases

### Use Case 1: Create a Payment
```bash
# 1. Create API key (via dashboard)
# 2. Create payment
curl -X POST https://hypertron-api.onrender.com/v1/payments \
  -H "Authorization: Bearer sk_test_xxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "amount": "25.00",
    "currency": "USDC",
    "description": "Premium subscription",
    "customer_email": "user@example.com",
    "customer_name": "John Doe",
    "metadata": {
      "order_id": "order_123",
      "plan": "premium"
    }
  }'

# 3. Customer pays via checkout_url
# 4. Receive webhook notification
```

### Use Case 2: List Recent Payments
```bash
curl "https://hypertron-api.onrender.com/v1/payments?limit=10" \
  -H "Authorization: Bearer sk_test_xxx"
```

### Use Case 3: Set Up Webhooks
```bash
# 1. Create webhook endpoint (via dashboard)
curl -X POST https://hypertron-api.onrender.com/api/developer/webhook-endpoints \
  -H "Cookie: ht_dashboard=xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhooks",
    "environment": "test",
    "events": ["payment.completed"],
    "description": "Payment completions"
  }'

# 2. Save the signing_secret for verification
# 3. Implement webhook handler on your server
```

---

## 🧪 Testing with Swagger UI

### Step 1: Open Swagger UI
Navigate to: `https://hypertron-api.onrender.com/docs`

### Step 2: Authorize
1. Click the **"Authorize"** button at the top right
2. For Merchant API:
   - Select **"ApiKey (http, Bearer)"**
   - Enter: `sk_test_your_key_here`
   - Click **"Authorize"**
3. For Dashboard API:
   - Authenticate via Freighter wallet first
   - Cookie is automatically set

### Step 3: Test Endpoints
1. Expand any endpoint category (e.g., "Payments")
2. Click on an endpoint (e.g., "POST /v1/payments")
3. Click **"Try it out"**
4. Fill in the required parameters
5. Click **"Execute"**
6. View the response below

### Step 4: View Models
- Scroll down to the **"Schemas"** section
- View all request/response models
- See field types, requirements, and examples

---

## 📝 Request/Response Examples

### Create Payment Request
```json
{
  "amount": "10.00",
  "currency": "USDC",
  "description": "Test payment",
  "customer_email": "test@example.com",
  "customer_name": "Test Customer",
  "metadata": {
    "order_id": "12345"
  }
}
```

### Create Payment Response (201)
```json
{
  "id": "pay_1234567890",
  "amount": "10.00",
  "currency": "USDC",
  "status": "created",
  "description": "Test payment",
  "customer_id": "cus_9876543210",
  "customer_email": "test@example.com",
  "customer_name": "Test Customer",
  "checkout_url": "https://pay.hypertron.xyz/cl_abcdef",
  "metadata": {
    "order_id": "12345"
  },
  "created_at": "2026-08-17T00:00:00.000Z",
  "updated_at": "2026-08-17T00:00:00.000Z"
}
```

### Error Response (400)
```json
{
  "error": {
    "code": "invalid_request",
    "message": "Validation error",
    "details": [
      {
        "field": "amount",
        "message": "Amount must be a positive number"
      }
    ],
    "request_id": "req_xxxxx"
  }
}
```

---

## 🔧 Environment Setup for Swagger

### Enable Swagger in Production

Add to Render environment variables:
```bash
SWAGGER_ENABLED=true
```

Then redeploy the service.

### Disable Swagger in Production

Remove the environment variable or set:
```bash
SWAGGER_ENABLED=false
```

**Security Note:** Consider restricting Swagger UI access in production using IP whitelisting or authentication.

---

## 🛠️ Development

### Run Locally with Swagger
```bash
# Install dependencies
npm install

# Start dev server
npm run start:dev

# Open Swagger UI
open http://localhost:3000/docs
```

### Generate OpenAPI Spec
```bash
# Generate spec file
npx ts-node scripts/generate-openapi-spec.ts

# Output: openapi-spec.json
```

### Import to Postman
1. Generate OpenAPI spec (see above)
2. Open Postman
3. Click **"Import"**
4. Select `openapi-spec.json`
5. All endpoints imported with documentation!

### Import to Insomnia
1. Generate OpenAPI spec
2. Open Insomnia
3. Click **"Import/Export"** → **"Import Data"**
4. Select **"From File"**
5. Choose `openapi-spec.json`

---

## 📊 Swagger Features

### ✅ Available Features

- **Interactive API Testing** - Try endpoints directly from the browser
- **Authentication Support** - Bearer token and cookie auth
- **Request/Response Examples** - See what to send and expect
- **Model Schemas** - View all data structures
- **Error Documentation** - Understand error codes and formats
- **Multi-Server Support** - Test against local, staging, or production
- **Persistent Authorization** - Stays logged in during session
- **Code Generation** - Generate client code in multiple languages

### 📋 Endpoint Documentation Includes

- **Summary** - Short description
- **Description** - Detailed explanation
- **Parameters** - Query, path, header, body params
- **Request Body** - Schema and examples
- **Responses** - All possible status codes with examples
- **Authorization** - Required auth method
- **Tags** - Endpoint categorization

---

## 🔍 Swagger UI Tips

### Tip 1: Test with Real Data
Use the "Try it out" feature with real API keys to test actual functionality.

### Tip 2: Copy as cURL
After executing a request, click "Copy as cURL" to get the exact command.

### Tip 3: Download Spec
Save the OpenAPI spec for offline use or client generation:
```bash
curl https://hypertron-api.onrender.com/docs-json > openapi-spec.json
```

### Tip 4: Filter by Tag
Use the filter box to search for specific endpoints.

### Tip 5: Expand/Collapse All
Use Ctrl+Shift+O (or Cmd+Shift+O on Mac) to expand/collapse all endpoints.

---

## 🚀 Next Steps

1. **Enable Swagger in Production**
   - Add `SWAGGER_ENABLED=true` to Render
   - Redeploy service
   - Test at `https://hypertron-api.onrender.com/docs`

2. **Generate API Clients**
   - Use OpenAPI Generator
   - Generate clients for your language
   - Integrate into your application

3. **Set Up Webhooks**
   - Create webhook endpoints
   - Implement handlers
   - Test with webhook deliveries

4. **Integrate Payments**
   - Create API key
   - Implement payment creation
   - Handle checkout flow

---

## 📞 Support

- **Documentation:** https://docs.hypertron.xyz
- **API Reference:** https://hypertron-api.onrender.com/docs
- **Support:** support@hypertron.xyz

---

**Last Updated:** August 17, 2026  
**API Version:** 1.0.0
