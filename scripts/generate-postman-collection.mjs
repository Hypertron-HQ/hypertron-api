import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'postman');

const jsonHeader = {
  key: 'Content-Type',
  value: 'application/json',
  type: 'text',
};

const authHeaders = {
  none: [],
  coreService: [
    {
      key: 'Authorization',
      value: 'Bearer {{serviceAccountApiKey}}',
      type: 'text',
    },
  ],
  dashboard: [
    {
      key: 'Cookie',
      value: 'ht_dashboard={{dashboardCookie}}',
      type: 'text',
    },
  ],
  internal: [
    {
      key: 'X-Internal-Token',
      value: '{{internalServiceToken}}',
      type: 'text',
    },
  ],
  merchant: [
    {
      key: 'Authorization',
      value: 'Bearer {{merchantApiKey}}',
      type: 'text',
    },
  ],
};

const authGuards = {
  none: '',
  coreService: `if (!pm.variables.get('serviceAccountApiKey')) {
  pm.execution.skipRequest();
  throw new Error('serviceAccountApiKey is empty. Set it in the selected Postman environment.');
}`,
  dashboard: `if (!pm.variables.get('dashboardCookie')) {
  pm.execution.skipRequest();
  throw new Error('dashboardCookie is empty. Run folders 00 and 01 first, and set authSecret.');
}`,
  internal: `if (!pm.variables.get('internalServiceToken')) {
  pm.execution.skipRequest();
  throw new Error('internalServiceToken is empty. Set it in the selected Postman environment.');
}`,
  merchant: `if (!pm.variables.get('merchantApiKey')) {
  pm.execution.skipRequest();
  throw new Error('merchantApiKey is empty. Run "02 — Developer API keys / Create test API key" first.');
}`,
};

function request({
  name,
  method = 'GET',
  url,
  auth = 'none',
  body,
  headers = [],
  description,
  prerequest,
  tests,
}) {
  const item = {
    name,
    request: {
      method,
      header: [
        ...authHeaders[auth],
        ...(body === undefined ? [] : [jsonHeader]),
        ...headers,
      ],
      url,
      description,
    },
    response: [],
  };

  if (body !== undefined) {
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  const events = [];
  const prerequestScript = [authGuards[auth], prerequest]
    .filter(Boolean)
    .join('\n');
  if (prerequestScript) {
    events.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: prerequestScript.split('\n'),
      },
    });
  }
  if (tests) {
    events.push({
      listen: 'test',
      script: { type: 'text/javascript', exec: tests.split('\n') },
    });
  }
  if (events.length > 0) item.event = events;

  return item;
}

function statusTest(expected, extra = '') {
  const statuses = Array.isArray(expected) ? expected : [expected];
  return `pm.test('Expected HTTP status', () => {
  pm.expect(${JSON.stringify(statuses)}).to.include(pm.response.code);
});
const setRuntime = (key, value) => {
  pm.collectionVariables.set(key, value);
  if (pm.environment) pm.environment.set(key, value);
};
${extra}`.trim();
}

const saveCoreIdentity = statusTest(
  200,
  `const json = pm.response.json();
if (json.walletAddress) setRuntime('walletAddress', json.walletAddress);`,
);

const saveBusiness = statusTest(
  200,
  `const json = pm.response.json();
if (json.businessId) setRuntime('businessId', json.businessId);`,
);

const saveApiKey = statusTest(
  201,
  `const json = pm.response.json();
if (json.id) setRuntime('apiKeyId', json.id);
if (json.secret_key) setRuntime('merchantApiKey', json.secret_key);`,
);

const saveRotatedApiKey = statusTest(
  200,
  `const json = pm.response.json();
if (json.id) setRuntime('apiKeyId', json.id);
if (json.secret_key) setRuntime('merchantApiKey', json.secret_key);`,
);

const savePayment = statusTest(
  201,
  `const json = pm.response.json();
if (json.id) setRuntime('paymentId', json.id);
const checkoutId = json.checkout_url && json.checkout_url.match(/(cl_[A-Za-z0-9]+)/);
if (checkoutId) setRuntime('checkoutLinkId', checkoutId[1]);
if (json.customer_id) setRuntime('customerDatabaseId', json.customer_id);`,
);

const saveCustomer = statusTest(
  200,
  `const json = pm.response.json();
const first = Array.isArray(json.data) ? json.data[0] : undefined;
if (first && first.id) setRuntime('customerId', first.id);`,
);

const saveWebhook = statusTest(
  201,
  `const json = pm.response.json();
if (json.id) setRuntime('webhookEndpointId', json.id);
if (json.signing_secret) setRuntime('webhookSigningSecret', json.signing_secret);`,
);

const saveRotatedWebhookSecret = statusTest(
  200,
  `const json = pm.response.json();
if (json.signing_secret) setRuntime('webhookSigningSecret', json.signing_secret);`,
);

const saveDelivery = statusTest(
  200,
  `const json = pm.response.json();
const first = Array.isArray(json.data) ? json.data[0] : undefined;
if (first && first.id) setRuntime('deliveryId', first.id);`,
);

const collection = {
  info: {
    _postman_id: '8cf55bf2-5d0a-48d8-bf42-d51b5bcd68b1',
    name: 'Hypertron Render — Complete API',
    description:
      'Complete deployed Hypertron API flow. Import the companion environment, fill the three secret variables, and run folders in order. Test records are created in the test environment.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          "const secret = pm.variables.get('authSecret');",
          "const wallet = pm.variables.get('walletAddress');",
          'if (secret && wallet) {',
          "  const CryptoJS = require('crypto-js');",
          '  const base64Url = (wordArray) => CryptoJS.enc.Base64',
          '    .stringify(wordArray)',
          "    .replace(/=/g, '')",
          "    .replace(/\\+/g, '-')",
          "    .replace(/\\//g, '_');",
          '  const payload = {',
          '    w: wallet,',
          '    exp: Math.floor(Date.now() / 1000) + 3600,',
          '  };',
          '  const encoded = base64Url(',
          '    CryptoJS.enc.Utf8.parse(JSON.stringify(payload)),',
          '  );',
          '  const signature = base64Url(CryptoJS.HmacSHA256(encoded, secret));',
          '  const dashboardCookie = `${encoded}.${signature}`;',
          "  pm.collectionVariables.set('dashboardCookie', dashboardCookie);",
          "  if (pm.environment) pm.environment.set('dashboardCookie', dashboardCookie);",
          '}',
        ],
      },
    },
  ],
  variable: [
    { key: 'apiBaseUrl', value: 'https://hypertron-api.onrender.com' },
    {
      key: 'coreBaseUrl',
      value: 'https://hypertron-core-backend.onrender.com',
    },
    { key: 'serviceAccountApiKey', value: '' },
    { key: 'internalServiceToken', value: '' },
    { key: 'authSecret', value: '' },
    { key: 'dashboardCookie', value: '' },
    { key: 'businessId', value: '' },
    { key: 'walletAddress', value: '' },
    {
      key: 'receiveAddress',
      value: 'GAZISNSU3JSJHGEWU2GUFXZSOGMNY2ECQBTJPWAB5P26M7MEUBCIIRKZ',
    },
    { key: 'merchantApiKey', value: '' },
    { key: 'apiKeyId', value: '' },
    { key: 'idempotencyKey', value: '' },
    { key: 'customerEmail', value: '' },
    { key: 'paymentId', value: '' },
    { key: 'checkoutLinkId', value: '' },
    { key: 'customerId', value: '' },
    { key: 'customerDatabaseId', value: '' },
    { key: 'webhookEndpointId', value: '' },
    { key: 'webhookSigningSecret', value: '' },
    { key: 'deliveryId', value: '' },
    { key: 'webhookTargetUrl', value: 'https://postman-echo.com/post' },
  ],
  item: [
    {
      name: '00 — Core backend setup',
      description:
        'Verifies the deployed core backend and captures the service wallet and business ID used by Hypertron API.',
      item: [
        request({
          name: 'Core identity',
          url: '{{coreBaseUrl}}/',
          tests: statusTest(200),
        }),
        request({
          name: 'Core health',
          url: '{{coreBaseUrl}}/health',
          tests: statusTest(200),
        }),
        request({
          name: 'Core auth/me — unauthenticated',
          url: '{{coreBaseUrl}}/api/auth/me',
          tests: statusTest(401),
        }),
        request({
          name: 'Core auth/me — service account',
          url: '{{coreBaseUrl}}/api/auth/me',
          auth: 'coreService',
          tests: saveCoreIdentity,
        }),
        request({
          name: 'Core business profile — service account',
          url: '{{coreBaseUrl}}/api/business/profile',
          auth: 'coreService',
          tests: saveBusiness,
        }),
      ],
    },
    {
      name: '01 — API health and internal sync',
      item: [
        request({
          name: 'API identity',
          url: '{{apiBaseUrl}}/',
          tests: statusTest(200),
        }),
        request({
          name: 'API health',
          url: '{{apiBaseUrl}}/health',
          tests: statusTest(200),
        }),
        request({
          name: 'Prometheus metrics',
          url: '{{apiBaseUrl}}/metrics',
          tests: statusTest(200),
        }),
        request({
          name: 'Sync merchant settings',
          method: 'PUT',
          url: '{{apiBaseUrl}}/internal/merchant-settings',
          auth: 'internal',
          body: {
            businessId: '{{businessId}}',
            walletAddress: '{{walletAddress}}',
            receiveAddress: '{{receiveAddress}}',
          },
          tests: statusTest(200),
        }),
      ],
    },
    {
      name: '02 — Developer API keys',
      item: [
        request({
          name: 'List API keys',
          url: '{{apiBaseUrl}}/api/developer/api-keys',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
        request({
          name: 'Create test API key',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/api-keys',
          auth: 'dashboard',
          body: {
            name: 'Postman test {{$timestamp}}',
            environment: 'test',
          },
          description:
            'Saves the one-time secret_key as merchantApiKey for subsequent merchant API requests.',
          tests: saveApiKey,
        }),
      ],
    },
    {
      name: '03 — Payments and checkout',
      item: [
        request({
          name: 'Create payment',
          method: 'POST',
          url: '{{apiBaseUrl}}/v1/payments',
          auth: 'merchant',
          headers: [
            {
              key: 'Idempotency-Key',
              value: '{{idempotencyKey}}',
              type: 'text',
            },
            {
              key: 'X-Request-Id',
              value: 'postman-{{$guid}}',
              type: 'text',
            },
          ],
          body: {
            amount: '4.00',
            currency: 'USDC',
            description: 'Postman Render flow',
            customer_email: '{{customerEmail}}',
            customer_name: 'Postman Test Customer',
            metadata: { source: 'postman' },
          },
          prerequest: `const nonce = Date.now();
const idempotencyKey = \`postman_\${nonce}_\${pm.variables.replaceIn('{{$guid}}')}\`;
const customerEmail = \`postman-\${nonce}@example.com\`;
pm.collectionVariables.set('idempotencyKey', idempotencyKey);
pm.collectionVariables.set('customerEmail', customerEmail);
if (pm.environment) {
  pm.environment.set('idempotencyKey', idempotencyKey);
  pm.environment.set('customerEmail', customerEmail);
}`,
          tests: savePayment,
        }),
        request({
          name: 'Replay payment idempotently',
          method: 'POST',
          url: '{{apiBaseUrl}}/v1/payments',
          auth: 'merchant',
          headers: [
            {
              key: 'Idempotency-Key',
              value: '{{idempotencyKey}}',
              type: 'text',
            },
          ],
          body: {
            amount: '4.00',
            currency: 'USDC',
            description: 'Postman Render flow',
            customer_email: '{{customerEmail}}',
            customer_name: 'Postman Test Customer',
            metadata: { source: 'postman' },
          },
          description:
            'Reuses the exact idempotency key and request body from Create payment.',
          tests: statusTest(201),
        }),
        request({
          name: 'List payments',
          url: '{{apiBaseUrl}}/v1/payments?limit=25',
          auth: 'merchant',
          tests: statusTest(200),
        }),
        request({
          name: 'Retrieve payment',
          url: '{{apiBaseUrl}}/v1/payments/{{paymentId}}',
          auth: 'merchant',
          tests: statusTest(200),
        }),
        request({
          name: 'List payment events',
          url: '{{apiBaseUrl}}/v1/payments/{{paymentId}}/events',
          auth: 'merchant',
          tests: statusTest(200),
        }),
        request({
          name: 'Retrieve public checkout link',
          url: '{{apiBaseUrl}}/v1/checkout-links/{{checkoutLinkId}}',
          tests: statusTest(200),
        }),
        request({
          name: 'Cancel payment',
          method: 'POST',
          url: '{{apiBaseUrl}}/v1/payments/{{paymentId}}/cancel',
          auth: 'merchant',
          tests: statusTest(200),
        }),
      ],
    },
    {
      name: '04 — Customers',
      item: [
        request({
          name: 'List customers — merchant API',
          url: '{{apiBaseUrl}}/v1/customers?limit=25',
          auth: 'merchant',
          tests: saveCustomer,
        }),
        request({
          name: 'Retrieve customer — merchant API',
          url: '{{apiBaseUrl}}/v1/customers/{{customerId}}',
          auth: 'merchant',
          tests: statusTest(200),
        }),
        request({
          name: 'List customers — dashboard',
          url: '{{apiBaseUrl}}/api/developer/customers?limit=25',
          auth: 'dashboard',
          tests: saveCustomer,
        }),
        request({
          name: 'Retrieve customer — dashboard',
          url: '{{apiBaseUrl}}/api/developer/customers/{{customerId}}',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
      ],
    },
    {
      name: '05 — Webhooks',
      item: [
        request({
          name: 'Create webhook endpoint',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints',
          auth: 'dashboard',
          body: {
            url: '{{webhookTargetUrl}}',
            environment: 'test',
            events: ['payment.completed', 'payment.failed'],
            description: 'Postman test endpoint',
          },
          tests: saveWebhook,
        }),
        request({
          name: 'List webhook endpoints',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
        request({
          name: 'Update webhook endpoint',
          method: 'PATCH',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}',
          auth: 'dashboard',
          body: {
            description: 'Updated by Postman',
            events: ['payment.completed'],
            active: true,
          },
          tests: statusTest(200),
        }),
        request({
          name: 'Rotate webhook signing secret',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}/rotate-secret',
          auth: 'dashboard',
          tests: saveRotatedWebhookSecret,
        }),
        request({
          name: 'Send test webhook',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}/test',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
        request({
          name: 'List webhook deliveries',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}/deliveries?limit=25',
          auth: 'dashboard',
          tests: saveDelivery,
        }),
        request({
          name: 'Retry webhook delivery — manual',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}/deliveries/{{deliveryId}}/retry',
          auth: 'dashboard',
          description:
            'Requires a real pending/failed delivery ID. Redis/workers are disabled on the current Render deployment, so 404 is expected until delivery processing is enabled.',
          tests: statusTest([200, 404]),
        }),
        request({
          name: 'Delete webhook endpoint',
          method: 'DELETE',
          url: '{{apiBaseUrl}}/api/developer/webhook-endpoints/{{webhookEndpointId}}',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
      ],
    },
    {
      name: '06 — API key cleanup',
      item: [
        request({
          name: 'Rotate API key',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/api-keys/{{apiKeyId}}/rotate',
          auth: 'dashboard',
          tests: saveRotatedApiKey,
        }),
        request({
          name: 'Revoke rotated API key',
          method: 'POST',
          url: '{{apiBaseUrl}}/api/developer/api-keys/{{apiKeyId}}/revoke',
          auth: 'dashboard',
          tests: statusTest(200),
        }),
      ],
    },
  ],
};

const environment = {
  id: 'd3355761-2d59-4dc6-b49a-ac0df3cb365e',
  name: 'Hypertron Render',
  values: [
    {
      key: 'apiBaseUrl',
      value: 'https://hypertron-api.onrender.com',
      type: 'default',
      enabled: true,
    },
    {
      key: 'coreBaseUrl',
      value: 'https://hypertron-core-backend.onrender.com',
      type: 'default',
      enabled: true,
    },
    {
      key: 'serviceAccountApiKey',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'internalServiceToken',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'authSecret',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'dashboardCookie',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'businessId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'walletAddress',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'merchantApiKey',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'apiKeyId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'idempotencyKey',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'customerEmail',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'paymentId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'checkoutLinkId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'customerId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'webhookEndpointId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'webhookSigningSecret',
      value: '',
      type: 'secret',
      enabled: true,
    },
    {
      key: 'deliveryId',
      value: '',
      type: 'default',
      enabled: true,
    },
    {
      key: 'receiveAddress',
      value: 'GAZISNSU3JSJHGEWU2GUFXZSOGMNY2ECQBTJPWAB5P26M7MEUBCIIRKZ',
      type: 'default',
      enabled: true,
    },
    {
      key: 'webhookTargetUrl',
      value: 'https://postman-echo.com/post',
      type: 'default',
      enabled: true,
    },
  ],
  _postman_variable_scope: 'environment',
  _postman_exported_at: new Date().toISOString(),
  _postman_exported_using: 'Hypertron generator',
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    resolve(outputDirectory, 'Hypertron_Render.postman_collection.json'),
    `${JSON.stringify(collection, null, 2)}\n`,
  ),
  writeFile(
    resolve(outputDirectory, 'Hypertron_Render.postman_environment.json'),
    `${JSON.stringify(environment, null, 2)}\n`,
  ),
]);

console.log(`Generated Postman files in ${outputDirectory}`);
