/**
 * Jest globalSetup — start Mongo (replica set) + Redis via docker compose for e2e.
 * Skip with E2E_SKIP_DOCKER=1 (tests that need infra will fail fast).
 */

import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(__dirname, '../..');
const STATE_PATH = join(__dirname, '.e2e-runtime.json');

async function waitTcp(host: string, port: number, attempts = 60): Promise<void> {
  const net = await import('node:net');
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function mongoEval(expr: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.e2e.yml',
      'exec',
      '-T',
      'mongo',
      'mongosh',
      '--quiet',
      '--eval',
      expr,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
}

async function initReplicaSet(): Promise<void> {
  let needsInit = true;
  try {
    const state = mongoEval('rs.status().myState');
    needsInit = state !== '1';
  } catch {
    needsInit = true;
  }

  if (needsInit) {
    try {
      mongoEval(
        'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})',
      );
    } catch {
      /* already initiated by a previous attempt */
    }
  }

  for (let i = 0; i < 40; i++) {
    try {
      const state = mongoEval('rs.status().myState');
      if (state === '1') return;
    } catch {
      /* still electing */
    }
    await sleep(500);
  }
  throw new Error('Mongo replica set did not become PRIMARY');
}

export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_SKIP_DOCKER === '1') {
    writeFileSync(STATE_PATH, JSON.stringify({ skipped: true }));
    return;
  }

  mkdirSync(__dirname, { recursive: true });

  try {
    execSync('docker compose -f docker-compose.e2e.yml down -v', {
      cwd: ROOT,
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }

  execSync('docker compose -f docker-compose.e2e.yml up -d --wait', {
    cwd: ROOT,
    stdio: 'inherit',
  });

  await waitTcp('127.0.0.1', 27018);
  await waitTcp('127.0.0.1', 6380);
  await initReplicaSet();

  const databaseUrl =
    'mongodb://127.0.0.1:27018/hypertron_e2e?replicaSet=rs0&directConnection=true';
  const redisUrl = 'redis://127.0.0.1:6380';

  execSync('pnpm exec prisma db push --skip-generate --accept-data-loss', {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });

  // Reproduce the two obsolete production indexes. Application startup must
  // replace transactionHash with a partial unique index and drop the API-key
  // prefix uniqueness restriction before the E2E flow starts.
  mongoEval(
    'db.getSiblingDB("hypertron_e2e").payments.createIndex({transactionHash:1},{unique:true,name:"payments_transactionHash_key"})',
  );
  mongoEval(
    'db.getSiblingDB("hypertron_e2e").api_keys.createIndex({businessId:1,environment:1,keyPrefix:1},{unique:true,name:"api_keys_businessId_environment_keyPrefix_key"})',
  );

  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        skipped: false,
        databaseUrl,
        redisUrl,
        authSecret: 'e2e-auth-secret-change-me-32b',
        encryptionKey: 'a'.repeat(64),
      },
      null,
      2,
    ),
  );
}
