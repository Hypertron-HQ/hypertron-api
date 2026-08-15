/**
 * Freighter dashboard session cookies — same format as hypertron-core-backend.
 * Cookie name: ht_dashboard = base64url(JSON({ w, exp })).hmac_sha256_base64url
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DASHBOARD_SESSION_COOKIE = 'ht_dashboard';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function isValidStellarAddress(value: string): boolean {
  return value.length === 56 && value.startsWith('G');
}

export function createDashboardSessionToken(
  walletAddress: string,
  secret: string,
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
): string {
  const payload = {
    w: walletAddress,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function parseDashboardWalletFromCookieHeader(
  cookieHeader: string | undefined,
  secret: string,
): string | null {
  const token = readCookie(cookieHeader, DASHBOARD_SESSION_COOKIE);
  if (!token || !secret) return null;

  const payload = parseSignedPayload(token, secret);
  if (
    !payload ||
    typeof payload.w !== 'string' ||
    !isValidStellarAddress(payload.w) ||
    !hasValidExpiration(payload.exp)
  ) {
    return null;
  }

  return payload.w;
}

/** Test helper: mint a signed ht_dashboard cookie value. */
export function generateTestDashboardSessionCookie(
  walletAddress: string,
  secret: string,
): string {
  return createDashboardSessionToken(walletAddress, secret);
}

/** Test helper: random-looking but valid-length G-address. */
export function fakeStellarAddress(seed = 'A'): string {
  const body = (seed + 'A'.repeat(54)).slice(0, 54).toUpperCase();
  return `G${body}`.slice(0, 56);
}

export function randomStellarAddress(): string {
  const hex = randomBytes(28).toString('hex').toUpperCase();
  return (`G${hex}` + 'A'.repeat(56)).slice(0, 56);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function isValidSignature(signature: string, expected: string): boolean {
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseSignedPayload(
  token: string,
  secret: string,
): Record<string, unknown> | null {
  const [encodedPayload, signature, ...rest] = token.split('.');
  if (!encodedPayload || !signature || rest.length > 0) return null;

  const expectedSignature = sign(encodedPayload, secret);
  if (!isValidSignature(signature, expectedSignature)) return null;

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
    return payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasValidExpiration(value: unknown): value is number {
  return (
    typeof value === 'number' && value >= Math.floor(Date.now() / 1000) - 60
  );
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(';')) {
    const [rawName, ...rawValue] = entry.trim().split('=');
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return null;
    }
  }
  return null;
}
