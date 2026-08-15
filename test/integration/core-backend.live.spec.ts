/**
 * Live check against hypertron-core-backend service account.
 *
 * Skipped unless CORE_BACKEND_URL and CORE_BACKEND_SERVICE_ACCOUNT_API_KEY are set
 * (or CORE_BACKEND_LIVE_TEST=1 with those vars). Does not log the key.
 */

const CORE_URL = (process.env.CORE_BACKEND_URL ?? '').replace(/\/$/, '');
const CORE_KEY = process.env.CORE_BACKEND_SERVICE_ACCOUNT_API_KEY ?? '';
const enabled =
  process.env.CORE_BACKEND_LIVE_TEST === '1' &&
  Boolean(CORE_URL) &&
  Boolean(CORE_KEY);

const describeLive = enabled ? describe : describe.skip;

describeLive('core-backend live service account', () => {
  it('missing/wrong key → 401', async () => {
    const res = await fetch(`${CORE_URL}/api/auth/me`, {
      headers: { Authorization: 'Bearer ht_svc_definitely_wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('valid key → 200 auth=service', async () => {
    const res = await fetch(`${CORE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${CORE_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: string; walletAddress: string };
    expect(body.auth).toBe('service');
    expect(body.walletAddress.startsWith('G')).toBe(true);
    expect(body.walletAddress).toHaveLength(56);
  });
});
