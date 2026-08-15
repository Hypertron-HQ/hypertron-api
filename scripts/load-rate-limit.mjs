#!/usr/bin/env node
/**
 * Load / rate-limit probe (Phase 10).
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   API_KEY=sk_test_... \
 *   LIMIT=60 \
 *   node scripts/load-rate-limit.mjs
 *
 * Expectation: first LIMIT creates succeed (201); next request returns 429
 * with Retry-After / X-RateLimit-* headers.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const API_KEY = process.env.API_KEY;
const LIMIT = Number(process.env.LIMIT ?? '60');

if (!API_KEY) {
  console.error('API_KEY is required');
  process.exit(1);
}

async function createPayment(i) {
  const res = await fetch(`${BASE_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `load-${Date.now()}-${i}`,
    },
    body: JSON.stringify({ amount: '1.00', currency: 'USDC' }),
  });
  return {
    i,
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    remaining: res.headers.get('x-ratelimit-remaining'),
  };
}

async function main() {
  console.log(`Probing ${BASE_URL} with LIMIT=${LIMIT}`);
  const started = Date.now();
  const results = [];

  for (let i = 0; i < LIMIT; i++) {
    results.push(await createPayment(i));
  }
  const overflow = await createPayment(LIMIT);

  const ok = results.filter((r) => r.status === 201).length;
  const other = results.filter((r) => r.status !== 201);

  console.log(
    JSON.stringify(
      {
        elapsedMs: Date.now() - started,
        succeeded: ok,
        unexpectedInBudget: other,
        overflow,
      },
      null,
      2,
    ),
  );

  if (ok < LIMIT) {
    console.error(`Expected ${LIMIT} successes before throttle, got ${ok}`);
    process.exit(2);
  }
  if (overflow.status !== 429) {
    console.error(`Expected overflow 429, got ${overflow.status}`);
    process.exit(3);
  }
  console.log('Rate limit threshold verified.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
