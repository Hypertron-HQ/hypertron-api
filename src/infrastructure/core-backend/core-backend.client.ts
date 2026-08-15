import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { CoreBackendConfig } from '@/common/config/core-backend.config';

export interface CoreAuthMe {
  auth: string;
  walletAddress: string;
}

export interface CoreBusinessProfile {
  id?: string;
  walletAddress?: string;
  receiveAddress?: string | null;
  [key: string]: unknown;
}

export interface CorePaymentLink {
  id?: string;
  [key: string]: unknown;
}

export class CoreBackendNotConfiguredError extends Error {
  constructor() {
    super(
      'CORE_BACKEND_URL or CORE_BACKEND_SERVICE_ACCOUNT_API_KEY is not configured',
    );
    this.name = 'CoreBackendNotConfiguredError';
  }
}

export class CoreBackendRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreBackendRequestError';
  }
}

@Injectable()
export class CoreBackendClient {
  private readonly logger = new Logger(CoreBackendClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const cfg = this.cfg();
    return Boolean(cfg.url && cfg.serviceAccountApiKey);
  }

  async getAuthMe(): Promise<CoreAuthMe> {
    return this.request<CoreAuthMe>('GET', '/api/auth/me');
  }

  async getBusinessProfile(): Promise<CoreBusinessProfile> {
    return this.request<CoreBusinessProfile>('GET', '/api/business/profile');
  }

  async getPaymentLink(id: string): Promise<CorePaymentLink> {
    const safeId = encodeURIComponent(id.trim());
    return this.request<CorePaymentLink>(
      'GET',
      `/api/payment-link/${safeId}`,
      undefined,
      { auth: false },
    );
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<T> {
    const cfg = this.cfg();
    if (!cfg.url || !cfg.serviceAccountApiKey) {
      throw new CoreBackendNotConfiguredError();
    }

    const url = `${cfg.url}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (opts.auth !== false) {
      headers.Authorization = `Bearer ${cfg.serviceAccountApiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }

      this.logger.log(`core-backend ${method} ${path} → ${res.status}`);

      if (!res.ok) {
        throw new CoreBackendRequestError(
          res.status,
          path,
          `core-backend ${method} ${path} returned ${res.status}`,
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof CoreBackendRequestError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ method, path, err: message }, 'core-backend request failed');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private cfg(): CoreBackendConfig {
    return (
      this.config.get<CoreBackendConfig>('coreBackend') ?? {
        url: '',
        serviceAccountApiKey: '',
        requestTimeoutMs: 8000,
      }
    );
  }
}
