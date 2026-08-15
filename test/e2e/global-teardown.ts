/**
 * Jest globalTeardown — stop e2e docker compose stack.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const STATE_PATH = join(__dirname, '.e2e-runtime.json');

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_DOCKER === '1') return;

  let skipped = false;
  if (existsSync(STATE_PATH)) {
    try {
      skipped = Boolean(JSON.parse(readFileSync(STATE_PATH, 'utf8')).skipped);
    } catch {
      /* ignore */
    }
    unlinkSync(STATE_PATH);
  }

  if (skipped || process.env.E2E_SKIP_DOCKER === '1') return;

  execSync('docker compose -f docker-compose.e2e.yml down -v', {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
