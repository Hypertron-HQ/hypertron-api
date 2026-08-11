/**
 * StellarHorizonService — read-only Horizon client with:
 *  - environment-based network selection (test → testnet, live → mainnet)
 *  - 10s request timeout
 *  - exponential backoff retries for transient network errors
 *  - circuit breaker to avoid hammering a degraded Horizon node
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon } from '@stellar/stellar-sdk';
import type { Environment } from '@prisma/client';

import type { StellarConfig } from '@/common/config/stellar.config';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

export interface HorizonPaymentRecord {
  id: string;
  transactionHash: string;
  from: string;
  to: string;
  amount: string;
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  createdAt: Date;
  memo: string | null;
  memoType: string | null;
  successful: boolean;
}

const HORIZON_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

@Injectable()
export class StellarHorizonService {
  private readonly logger = new Logger(StellarHorizonService.name);
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly servers = new Map<string, Horizon.Server>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Lists recent inbound classic payments for `accountId`, enriched with
   * transaction memo. Ordered newest-first.
   */
  async listPaymentsForAccount(
    accountId: string,
    environment: Environment,
    limit = 50,
  ): Promise<HorizonPaymentRecord[]> {
    const server = this.getServer(environment);
    const breaker = this.getBreaker(environment);

    return breaker.exec(async () => {
      const page = await this.withRetry(() =>
        server
          .payments()
          .forAccount(accountId)
          .order('desc')
          .limit(limit)
          .join('transactions')
          .call(),
      );

      const records: HorizonPaymentRecord[] = [];

      for (const op of page.records) {
        if (op.type !== 'payment') continue;

        const payment = op as Horizon.ServerApi.PaymentOperationRecord & {
          transaction_attr?: {
            memo?: string | null;
            memo_type?: string | null;
            successful?: boolean;
          };
        };

        // Prefer joined transaction attributes; fall back to a fetch.
        let memo: string | null = payment.transaction_attr?.memo ?? null;
        let memoType: string | null =
          payment.transaction_attr?.memo_type ?? null;
        let successful = payment.transaction_attr?.successful ?? true;

        if (payment.transaction_attr === undefined) {
          try {
            const tx = await this.withRetry(() => payment.transaction());
            memo = tx.memo ?? null;
            memoType = tx.memo_type ?? null;
            successful = tx.successful;
          } catch (err) {
            this.logger.warn(
              {
                tx: payment.transaction_hash,
                err: err instanceof Error ? err.message : String(err),
              },
              'Failed to load transaction for payment op',
            );
            continue;
          }
        }

        records.push({
          id: payment.id,
          transactionHash: payment.transaction_hash,
          from: payment.from,
          to: payment.to,
          amount: payment.amount,
          assetType: payment.asset_type,
          assetCode:
            payment.asset_type === 'native'
              ? 'XLM'
              : (payment.asset_code ?? null),
          assetIssuer:
            payment.asset_type === 'native'
              ? null
              : (payment.asset_issuer ?? null),
          createdAt: new Date(payment.created_at),
          memo,
          memoType,
          successful,
        });
      }

      return records;
    });
  }

  /** Loads a single transaction by hash; returns null if missing. */
  async getTransaction(
    hash: string,
    environment: Environment,
  ): Promise<{ hash: string; successful: boolean; ledger: number } | null> {
    const server = this.getServer(environment);
    const breaker = this.getBreaker(environment);

    try {
      return await breaker.exec(async () => {
        const tx = await this.withRetry(() =>
          server.transactions().transaction(hash).call(),
        );
        return {
          hash: tx.hash,
          successful: tx.successful,
          ledger: tx.ledger_attr,
        };
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) throw err;
      const status =
        err &&
        typeof err === 'object' &&
        'response' in err &&
        (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  isCircuitOpen(environment: Environment): boolean {
    return this.getBreaker(environment).getState() === 'open';
  }

  private getServer(environment: Environment): Horizon.Server {
    const key = environment === 'live' ? 'live' : 'test';
    let server = this.servers.get(key);
    if (!server) {
      const stellar = this.config.get<StellarConfig>('stellar')!;
      const url =
        environment === 'live'
          ? stellar.mainnetHorizonUrl
          : stellar.testnetHorizonUrl;
      server = new Horizon.Server(url, { allowHttp: url.startsWith('http:') });
      this.servers.set(key, server);
    }
    return server;
  }

  private getBreaker(environment: Environment): CircuitBreaker {
    const key = environment === 'live' ? 'live' : 'test';
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
      });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await withTimeout(fn(), HORIZON_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        if (err instanceof CircuitOpenError) throw err;
        if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
        const delay = Math.min(1000 * 2 ** attempt, 8_000);
        await sleep(delay);
      }
    }
    throw lastErr;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Horizon request timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  if (msg.includes('timed out') || msg.includes('econnreset')) return true;
  if (msg.includes('enotfound') || msg.includes('econnrefused')) return true;
  const status =
    err &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response?: { status?: number } }).response?.status;
  if (typeof status === 'number' && status >= 500) return true;
  if (status === 429) return true;
  return false;
}
