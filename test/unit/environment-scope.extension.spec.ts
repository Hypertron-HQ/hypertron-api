import {
  assertEnvironmentScope,
  MissingEnvironmentError,
} from '@/infrastructure/prisma/environment-scope.extension';

/**
 * Behavioural contract for A6 — merchant-scoped queries must carry environment.
 * Full Prisma.$extends wiring is covered via PaymentsRepository integration tests.
 */
describe('environment-scope rules', () => {
  it('throws when Payment.findMany has businessId but no environment', () => {
    expect(() =>
      assertEnvironmentScope('Payment', 'findMany', {
        where: { businessId: 'biz_1' },
      }),
    ).toThrow(MissingEnvironmentError);
  });

  it('allows Payment.findMany with businessId + environment', () => {
    expect(() =>
      assertEnvironmentScope('Payment', 'findMany', {
        where: { businessId: 'biz_1', environment: 'test' },
      }),
    ).not.toThrow();
  });

  it('allows reconciler-style Payment.findMany without businessId', () => {
    expect(() =>
      assertEnvironmentScope('Payment', 'findMany', {
        where: { status: 'pending' },
      }),
    ).not.toThrow();
  });

  it('throws on Payment.create without environment', () => {
    expect(() =>
      assertEnvironmentScope('Payment', 'create', {
        data: { businessId: 'biz_1', amount: '1.00' },
      }),
    ).toThrow(MissingEnvironmentError);
  });

  it('does not enforce on Customer', () => {
    expect(() =>
      assertEnvironmentScope('Customer', 'findMany', {
        where: { businessId: 'biz_1' },
      }),
    ).not.toThrow();
  });

  it('allows explicit dashboard scope across test and live', () => {
    expect(() =>
      assertEnvironmentScope('ApiKey', 'findMany', {
        where: {
          businessId: { in: ['biz_1'] },
          environment: { in: ['test', 'live'] },
        },
      }),
    ).not.toThrow();
  });

  it('allows a business-scoped globally unique publicId lookup', () => {
    expect(() =>
      assertEnvironmentScope('WebhookEndpoint', 'findFirst', {
        where: { publicId: 'we_123', businessId: 'biz_1' },
      }),
    ).not.toThrow();
  });

  it('still rejects a non-unique business lookup without environment', () => {
    expect(() =>
      assertEnvironmentScope('WebhookEndpoint', 'findFirst', {
        where: { url: 'https://example.com', businessId: 'biz_1' },
      }),
    ).toThrow(MissingEnvironmentError);
  });
});
