/**
 * SessionGuard — authenticates /api/developer/* via Freighter ht_dashboard cookie.
 *
 * Cookie is HMAC-signed with AUTH_SECRET (shared with hypertron-core-backend).
 * Resolves walletAddress → MerchantSettings.businessId (pushed from core).
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import {
  createDashboardSessionToken,
  DASHBOARD_SESSION_COOKIE,
  parseDashboardWalletFromCookieHeader,
} from '@/common/auth/dashboard-session';
import { AuthenticationException } from '@/common/exceptions/hypertron.exception';
import {
  SESSION_USER_KEY,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';
import type { SecurityConfig } from '@/common/config/security.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [SESSION_USER_KEY]: SessionUser }>();

    const secret =
      this.config.get<SecurityConfig>('security')?.authSecret?.trim() ?? '';
    if (!secret) {
      throw new AuthenticationException(
        'server_misconfigured',
        'AUTH_SECRET is not configured.',
      );
    }

    const cookieHeader = request.headers.cookie;
    const hasDashboardCookie = Boolean(
      cookieHeader
        ?.split(';')
        .some((entry) =>
          entry.trim().startsWith(`${DASHBOARD_SESSION_COOKIE}=`),
        ),
    );

    const walletAddress = parseDashboardWalletFromCookieHeader(
      cookieHeader,
      secret,
    );

    if (!walletAddress) {
      throw new AuthenticationException(
        hasDashboardCookie ? 'invalid_session_token' : 'missing_session_token',
        hasDashboardCookie
          ? 'The Freighter session cookie is invalid or has expired.'
          : 'No Freighter session cookie. Sign in with Freighter on the dashboard first.',
      );
    }

    const settings = await this.prisma.merchantSettings.findUnique({
      where: { walletAddress },
      select: { businessId: true },
    });

    if (!settings) {
      this.logger.warn(
        { walletAddress },
        'No MerchantSettings for wallet session',
      );
      throw new AuthenticationException(
        'invalid_session_token',
        'No merchant workspace for this wallet. Complete Freighter sign-in on the core app first.',
      );
    }

    request[SESSION_USER_KEY] = {
      walletAddress,
      businessId: settings.businessId,
      role: 'owner',
    };
    return true;
  }
}

/**
 * Test helper: mint a signed ht_dashboard cookie value (not a Bearer token).
 */
export function generateTestSessionCookie(
  walletAddress: string,
  secret: string,
  ttlSeconds = 60 * 60,
): string {
  return createDashboardSessionToken(walletAddress, secret, ttlSeconds);
}
