import {
  CircuitBreaker,
  CircuitOpenError,
} from '@/infrastructure/stellar/circuit-breaker';

describe('CircuitBreaker', () => {
  it('opens after failureThreshold consecutive failures', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 60_000,
    });

    await expect(
      breaker.exec(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      breaker.exec(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(breaker.getState()).toBe('open');
    await expect(breaker.exec(async () => 'ok')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it('resets to closed after a successful half-open probe', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });

    await expect(
      breaker.exec(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('open');

    await new Promise((r) => setTimeout(r, 15));
    expect(breaker.getState()).toBe('half-open');

    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });
});
