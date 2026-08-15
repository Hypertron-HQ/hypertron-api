/**
 * Unit tests for CoreBackendClient (mocked fetch — no live network).
 */

import { ConfigService } from '@nestjs/config';

import {
  CoreBackendClient,
  CoreBackendNotConfiguredError,
  CoreBackendRequestError,
} from '@/infrastructure/core-backend/core-backend.client';

describe('CoreBackendClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function clientWith(url: string, key: string): CoreBackendClient {
    const config = {
      get: jest.fn().mockReturnValue({
        url,
        serviceAccountApiKey: key,
        requestTimeoutMs: 8000,
      }),
    } as unknown as ConfigService;
    return new CoreBackendClient(config);
  }

  it('isConfigured is false when url or key is missing', () => {
    expect(clientWith('', 'ht_svc_abc').isConfigured()).toBe(false);
    expect(clientWith('https://core.example', '').isConfigured()).toBe(false);
    expect(clientWith('https://core.example', 'ht_svc_abc').isConfigured()).toBe(
      true,
    );
  });

  it('throws CoreBackendNotConfiguredError when calling without config', async () => {
    await expect(clientWith('', '').getAuthMe()).rejects.toBeInstanceOf(
      CoreBackendNotConfiguredError,
    );
  });

  it('sends Authorization Bearer and returns JSON on 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          auth: 'service',
          walletAddress: 'GSVCACCOUNTTESTNET00000000000000000000000000000000000000',
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = clientWith(
      'https://hypertron-core-backend.onrender.com',
      'ht_svc_testkey_do_not_commit',
    );
    const me = await client.getAuthMe();

    expect(me.auth).toBe('service');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://hypertron-core-backend.onrender.com/api/auth/me',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ht_svc_testkey_do_not_commit',
    );
  });

  it('throws CoreBackendRequestError on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Unauthorized' }),
    }) as unknown as typeof fetch;

    const client = clientWith('https://core.example', 'bad-key-value-here!!');
    await expect(client.getAuthMe()).rejects.toMatchObject({
      name: 'CoreBackendRequestError',
      status: 401,
    });
  });

  it('GET payment-link does not send Authorization', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'link_1' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = clientWith('https://core.example', 'ht_svc_testkey_do_not_commit');
    await client.getPaymentLink('abc123');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
