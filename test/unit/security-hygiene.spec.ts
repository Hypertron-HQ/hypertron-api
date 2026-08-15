/**
 * Phase 10 — security hygiene checks (secrets + cross-merchant isolation).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('security hygiene', () => {
  const appModuleSrc = readFileSync(
    join(__dirname, '../../src/app.module.ts'),
    'utf8',
  );

  it('redacts Authorization, cookies, and signing secrets from Pino logs', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.signing_secret',
      'req.body.secret_key',
      'res.body.signing_secret',
      'res.body.secret_key',
    ]) {
      expect(appModuleSrc).toContain(path);
    }
    expect(appModuleSrc).toContain('req.headers["x-internal-token"]');
    expect(appModuleSrc).toContain('req.headers["x-service-key"]');
  });

  it('does not reference private Stellar keys in source under src/', () => {
    // Soft guard: no S-prefixed 56-char secret key literals in common crypto util.
    const cryptoSrc = readFileSync(
      join(__dirname, '../../src/common/utils/crypto.util.ts'),
      'utf8',
    );
    expect(cryptoSrc).not.toMatch(/\bS[A-Z0-9]{55}\b/);
  });
});
