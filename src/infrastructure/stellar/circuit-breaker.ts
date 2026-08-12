/**
 * Simple in-memory circuit breaker for Horizon HTTP calls.
 *
 * States:
 *  - closed:    traffic flows; failures increment a counter
 *  - open:      short-circuit all calls until resetTimeout elapses
 *  - half-open: allow one probe; success → closed, failure → open
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** Ms to stay open before probing again. Default 30_000. */
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();

    if (this.state === 'open') {
      throw new CircuitOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private maybeHalfOpen(): void {
    if (
      this.state === 'open' &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      this.state = 'half-open';
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
