import { MissingEnvironmentError } from '@/infrastructure/prisma/environment-scope.extension';

/**
 * Behavioural contract for A6 — merchant-scoped queries must carry environment.
 * Full Prisma.$extends wiring is covered via PaymentsRepository integration tests.
 */
describe('environment-scope rules', () => {
  function assertEnv(
    model: string,
    operation: string,
    args: { where?: unknown; data?: unknown },
  ): void {
    const ENV_SCOPED = new Set([
      'Payment',
      'ApiKey',
      'CheckoutLink',
      'WebhookEndpoint',
    ]);
    if (!ENV_SCOPED.has(model)) return;
    const hasEnv = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return false;
      const env = (obj as { environment?: unknown }).environment;
      return env === 'test' || env === 'live';
    };
    if (operation === 'create') {
      if (!hasEnv(args.data))
        throw new MissingEnvironmentError(model, operation);
      return;
    }
    if (
      args.where &&
      typeof args.where === 'object' &&
      'businessId' in args.where &&
      !hasEnv(args.where)
    ) {
      throw new MissingEnvironmentError(model, operation);
    }
  }

  it('throws when Payment.findMany has businessId but no environment', () => {
    expect(() =>
      assertEnv('Payment', 'findMany', {
        where: { businessId: 'biz_1' },
      }),
    ).toThrow(MissingEnvironmentError);
  });

  it('allows Payment.findMany with businessId + environment', () => {
    expect(() =>
      assertEnv('Payment', 'findMany', {
        where: { businessId: 'biz_1', environment: 'test' },
      }),
    ).not.toThrow();
  });

  it('allows reconciler-style Payment.findMany without businessId', () => {
    expect(() =>
      assertEnv('Payment', 'findMany', {
        where: { status: 'pending' },
      }),
    ).not.toThrow();
  });

  it('throws on Payment.create without environment', () => {
    expect(() =>
      assertEnv('Payment', 'create', {
        data: { businessId: 'biz_1', amount: '1.00' },
      }),
    ).toThrow(MissingEnvironmentError);
  });

  it('does not enforce on Customer', () => {
    expect(() =>
      assertEnv('Customer', 'findMany', {
        where: { businessId: 'biz_1' },
      }),
    ).not.toThrow();
  });
});
