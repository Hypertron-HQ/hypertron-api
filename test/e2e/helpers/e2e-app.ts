/**
 * Shared Nest bootstrap + seed helpers for Phase 10 e2e suites.
 */

import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { AppModule } from '@/app.module';
import { HypertronExceptionFilter } from '@/common/filters/hypertron-exception.filter';
import { ThrottlerExceptionFilter } from '@/common/filters/throttler-exception.filter';
import { RequestIdInterceptor } from '@/common/interceptors/request-id.interceptor';
import { generateTestSessionCookie } from '@/common/guards/session.guard';
import { DASHBOARD_SESSION_COOKIE } from '@/common/auth/dashboard-session';
import { generateApiKey, hashApiKey } from '@/common/utils/crypto.util';
import { generateId, PREFIXES } from '@/common/utils/id-generator';

export const E2E_AUTH_SECRET =
  process.env.AUTH_SECRET ?? 'e2e-auth-secret-change-me-32b';

export const WALLET_A =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
export const WALLET_B =
  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
export const DEST_A =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

export function requireE2eInfra(): void {
  if (
    process.env.E2E_SKIP_DOCKER === '1' ||
    process.env.E2E_RUNTIME_MISSING === '1'
  ) {
    throw new Error(
      'E2E Docker infra is not available. Unset E2E_SKIP_DOCKER and run `pnpm test:e2e`.',
    );
  }
}

export async function createE2eApp(): Promise<{
  app: INestApplication;
  prisma: PrismaClient;
}> {
  requireE2eInfra();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(
    new ThrottlerExceptionFilter(),
    new HypertronExceptionFilter(),
  );
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();

  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  await prisma.$connect();

  return { app, prisma };
}

export async function resetE2eDb(prisma: PrismaClient): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.checkoutLink.deleteMany();
  await prisma.merchantSettings.deleteMany();
}

export async function seedBusiness(
  prisma: PrismaClient,
  opts: { id: string; walletAddress: string; receiveAddress?: string },
) {
  return prisma.merchantSettings.create({
    data: {
      businessId: opts.id,
      walletAddress: opts.walletAddress,
      receiveAddress: opts.receiveAddress ?? DEST_A,
    },
  });
}

export async function seedApiKey(
  prisma: PrismaClient,
  opts: {
    businessId: string;
    environment?: 'test' | 'live';
    active?: boolean;
  },
): Promise<{ rawKey: string; publicId: string }> {
  const environment = opts.environment ?? 'test';
  const rawKey = generateApiKey(environment);
  const publicId = generateId(PREFIXES.API_KEY);
  await prisma.apiKey.create({
    data: {
      publicId,
      businessId: opts.businessId,
      name: `${environment} e2e key`,
      environment,
      keyPrefix: `sk_${environment}_`,
      secretHash: await hashApiKey(rawKey, 4),
      lastFour: rawKey.slice(-4),
      active: opts.active ?? true,
    },
  });
  return { rawKey, publicId };
}

export function sessionCookie(walletAddress: string): string {
  const token = generateTestSessionCookie(walletAddress, E2E_AUTH_SECRET);
  return `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

export function authHeader(rawKey: string): { Authorization: string } {
  return { Authorization: `Bearer ${rawKey}` };
}
