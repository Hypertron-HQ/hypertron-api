# Enable Swagger Documentation - Step-by-Step Guide

## 🎯 Objective

Enable interactive Swagger/OpenAPI documentation for the Hypertron API in production (Render).

---

## ✅ What Was Done

1. **Enhanced OpenAPI Configuration** ✅
   - Added comprehensive API description
   - Included all authentication methods
   - Added Render production server URL
   - Enhanced endpoint documentation
   - Added Internal API tag and documentation

2. **Updated Internal Endpoints** ✅
   - Added Swagger documentation to merchant settings controller
   - Exposed internal endpoints in API documentation
   - Added proper request/response schemas

3. **Created Test Scripts** ✅
   - `test-swagger.sh` - Tests Swagger accessibility
   - `scripts/generate-openapi-spec.ts` - Generates OpenAPI spec file

4. **Created Documentation** ✅
   - `SWAGGER_DOCUMENTATION.md` - Comprehensive API reference
   - Usage examples for all endpoints
   - Authentication guides
   - Testing instructions

---

## 🚀 How to Enable Swagger in Production

### Step 1: Add Environment Variable in Render

1. **Go to Render Dashboard:**
   - Navigate to: https://dashboard.render.com
   - Select your `hypertron-api` service

2. **Add Environment Variable:**
   - Click on **"Environment"** in the left sidebar
   - Click **"Add Environment Variable"**
   - Enter:
     - **Key:** `SWAGGER_ENABLED`
     - **Value:** `true`
   - Click **"Save Changes"**

3. **Redeploy Service:**
   - Render will automatically redeploy
   - Or click **"Manual Deploy"** → **"Deploy latest commit"**
   - Wait for deployment to complete (~2-3 minutes)

### Step 2: Verify Swagger is Accessible

```bash
# Test Swagger UI endpoint
curl -I https://hypertron-api.onrender.com/docs

# Should return:
# HTTP/2 200
# content-type: text/html; charset=utf-8
```

### Step 3: Open Swagger UI

Open in your browser:
```
https://hypertron-api.onrender.com/docs
```

You should see the interactive Swagger UI interface!

---

## 📸 Expected Result

When Swagger is enabled, you'll see:

### Swagger UI Homepage
- **Title:** Hypertron Payments API
- **Version:** 1.0.0
- **Description:** Full API description with Getting Started guide
- **Servers:** Dropdown to select environment (Local, Render, Custom Domain)

### Endpoint Categories
- 🏥 **Health** - Health checks and service status
- 💳 **Payments** - Create, read, list, and cancel payments
- 👥 **Customers** - Merchant-scoped customer records
- 🔗 **Checkout Links** - Public hosted-checkout links
- 🔧 **Developer** - Dashboard API keys and webhooks
- ⚙️ **Internal** - Internal service-to-service endpoints

### Features Available
- ✅ Interactive API testing
- ✅ Authentication (Authorize button)
- ✅ Request/response examples
- ✅ Model schemas
- ✅ Error documentation
- ✅ Copy as cURL
- ✅ Download OpenAPI spec

---

## 🧪 Testing Swagger

### Test 1: Access Swagger UI
```bash
curl https://hypertron-api.onrender.com/docs
# Should return HTML content
```

### Test 2: Get OpenAPI JSON
```bash
curl https://hypertron-api.onrender.com/docs-json | jq .info
# Should return API info object
```

### Test 3: Interactive Testing
1. Open `https://hypertron-api.onrender.com/docs`
2. Click **"Authorize"** button
3. Enter API key: `Bearer sk_test_your_key`
4. Click **"Authorize"**
5. Expand **"Payments"** section
6. Click **"GET /v1/payments"**
7. Click **"Try it out"**
8. Click **"Execute"**
9. View response

---

## 🔧 Alternative: Enable Swagger via Code

If you can't use environment variables, you can force enable Swagger in code:

### Option 1: Edit main.ts (Not Recommended for Production)

```typescript
// src/main.ts
// Change this:
if (appConfig.swaggerEnabled || appConfig.nodeEnv !== 'production') {

// To this (always enable):
if (true) {
```

### Option 2: Edit app.config.ts

```typescript
// src/common/config/app.config.ts
export const appConfig = registerAs('app', () => ({
  // ... other config
  swaggerEnabled: process.env.SWAGGER_ENABLED === 'true' || true, // Add || true
}));
```

**Note:** Using environment variables is the preferred method.

---

## 🔒 Security Considerations

### Option 1: Keep Swagger Enabled (Recommended for Development)
```bash
# In Render environment
SWAGGER_ENABLED=true
```

**Pros:**
- Easy API exploration
- Self-documenting
- Simplifies integration
- Helps with debugging

**Cons:**
- Exposes API structure
- May reveal internal endpoints

### Option 2: Protect Swagger with Authentication

Add middleware to protect the /docs endpoint:

```typescript
// src/main.ts
import * as basicAuth from 'express-basic-auth';

// Before SwaggerModule.setup
if (appConfig.swaggerEnabled || appConfig.nodeEnv !== 'production') {
  // Add basic auth for /docs endpoint
  app.use(
    '/docs*',
    basicAuth({
      users: {
        [process.env.SWAGGER_USERNAME || 'admin']: 
          process.env.SWAGGER_PASSWORD || 'changeme',
      },
      challenge: true,
    }),
  );
  
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
```

Then set in Render:
```bash
SWAGGER_ENABLED=true
SWAGGER_USERNAME=admin
SWAGGER_PASSWORD=your-secure-password
```

### Option 3: IP Whitelisting

Use Render's network policies or a reverse proxy to restrict access by IP address.

### Option 4: Disable in Production

```bash
# In Render environment
SWAGGER_ENABLED=false
# or remove the variable entirely
```

---

## 📝 Using the API Documentation

### For Developers

1. **Explore Endpoints:**
   - Browse all available endpoints by category
   - Read descriptions and parameters
   - View request/response examples

2. **Test API Calls:**
   - Use "Try it out" to make real API calls
   - Authenticate with your API key
   - View actual responses

3. **Generate Client Code:**
   - Download OpenAPI spec
   - Use OpenAPI Generator
   - Create client SDKs

4. **Integration:**
   - Copy cURL commands
   - Use in your application
   - Implement error handling

### For QA/Testing

1. **Manual Testing:**
   - Test all endpoints interactively
   - Verify request/response formats
   - Check error scenarios

2. **Generate Test Cases:**
   - Use Swagger examples as test data
   - Validate against schema
   - Document bugs with exact requests

### For Product/Documentation

1. **API Reference:**
   - Use as authoritative API documentation
   - Share with partners/customers
   - Keep documentation in sync with code

2. **Contract Testing:**
   - Validate API contracts
   - Ensure backward compatibility
   - Generate mock servers

---

## 🎓 Quick Reference

### URLs
| Resource | URL |
|----------|-----|
| Swagger UI | https://hypertron-api.onrender.com/docs |
| OpenAPI JSON | https://hypertron-api.onrender.com/docs-json |
| API Base | https://hypertron-api.onrender.com |

### Environment Variables
| Variable | Value | Purpose |
|----------|-------|---------|
| `SWAGGER_ENABLED` | `true` | Enable Swagger UI |
| `NODE_ENV` | `production` | Environment mode |

### Commands
```bash
# Test Swagger
./test-swagger.sh

# Generate OpenAPI spec
npx ts-node scripts/generate-openapi-spec.ts

# Test API endpoint
curl https://hypertron-api.onrender.com/health
```

---

## 🐛 Troubleshooting

### Problem: Swagger returns 502
**Solution:** Add `SWAGGER_ENABLED=true` and redeploy

### Problem: Swagger returns 404
**Solution:** Check that `SWAGGER_ENABLED=true` is set correctly

### Problem: "Try it out" fails with CORS error
**Solution:** Ensure your domain is in `CORS_ORIGINS` environment variable

### Problem: Authentication doesn't work
**Solution:** 
1. Check API key format (should start with `sk_test_` or `sk_live_`)
2. Ensure key is active (not revoked)
3. Use Bearer token format: `Bearer sk_test_xxx`

### Problem: Some endpoints missing
**Solution:** 
1. Check that all controllers have `@ApiTags()` decorator
2. Ensure endpoints have `@ApiOperation()` decorator
3. Regenerate OpenAPI spec

---

## ✅ Verification Checklist

After enabling Swagger, verify:

- [ ] Swagger UI loads at `/docs`
- [ ] All 6 endpoint categories visible (Health, Payments, Customers, Checkout Links, Developer, Internal)
- [ ] OpenAPI JSON accessible at `/docs-json`
- [ ] "Authorize" button works
- [ ] Can test public endpoints (Health, Metrics)
- [ ] Can test authenticated endpoints with API key
- [ ] Request/response schemas displayed correctly
- [ ] Error examples shown
- [ ] cURL commands can be copied
- [ ] Models section shows all DTOs

---

## 📊 Current Status

**Swagger Configuration:** ✅ Complete
**Production Status:** ⚠️ Needs `SWAGGER_ENABLED=true` in Render
**Documentation:** ✅ Complete
**Testing Scripts:** ✅ Created

---

## 🎯 Next Steps

1. **Immediate:**
   - [ ] Add `SWAGGER_ENABLED=true` to Render
   - [ ] Redeploy service
   - [ ] Verify Swagger UI is accessible
   - [ ] Test all endpoint categories

2. **Short-term:**
   - [ ] Share Swagger URL with team
   - [ ] Create integration examples
   - [ ] Document common use cases
   - [ ] Set up automated tests

3. **Long-term:**
   - [ ] Generate client SDKs
   - [ ] Create public API documentation site
   - [ ] Implement API versioning strategy
   - [ ] Add more detailed examples

---

## 📞 Support

If you encounter issues:
1. Check this guide's troubleshooting section
2. Review `SWAGGER_DOCUMENTATION.md`
3. Run `./test-swagger.sh` for diagnostics
4. Check Render logs for errors

---

**Last Updated:** August 17, 2026  
**Status:** Ready to Enable
