/**
 * Shared test stub — skips rate limiting in integration suites that do not
 * boot ThrottlerModule.forRoot (AppModule).
 */
export const passThroughThrottlerGuard = {
  canActivate: () => true,
};
