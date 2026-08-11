/**
 * StellarVerifier — classic Horizon payment match checks (Plan §12.2).
 *
 * A record is a valid match only when ALL seven checks pass:
 *  destination, asset_code, asset_issuer, amount, memo, tx uniqueness, expiry.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment, Payment, PaymentCurrency } from '@prisma/client';

import type { StellarConfig } from '@/common/config/stellar.config';
import { compareDecimalStrings } from '@/common/utils/amount.util';
import type { HorizonPaymentRecord } from '@/infrastructure/stellar/stellar-horizon.service';

export type VerifyFailureCode =
  | 'wrong_asset'
  | 'wrong_issuer'
  | 'insufficient_amount'
  | 'wrong_amount'
  | 'memo_mismatch'
  | 'wrong_destination'
  | 'expired'
  | 'duplicate_hash'
  | 'tx_unsuccessful'
  | 'no_match';

export type VerifyResult =
  | { ok: true; payment: HorizonPaymentRecord }
  | { ok: false; code: VerifyFailureCode; message: string; payment?: HorizonPaymentRecord };

@Injectable()
export class StellarVerifier {
  constructor(private readonly config: ConfigService) {}

  /**
   * Scans Horizon records for the first valid match for `payment`.
   * Memo-matched but invalid ops surface a typed failure (wrong asset/amount/…).
   * Unrelated ops are ignored.
   */
  verify(
    payment: Payment,
    records: HorizonPaymentRecord[],
    knownHashes: Set<string>,
  ): VerifyResult {
    let memoHit: HorizonPaymentRecord | undefined;

    for (const record of records) {
      if (!record.successful) continue;
      if (record.memoType !== 'text' && record.memoType !== null) {
        // Only text memos are used for hpl_ attribution
      }
      if (record.memo !== payment.linkMemo) continue;

      memoHit = record;
      const check = this.checkRecord(payment, record, knownHashes);
      if (check.ok) return check;
      // Memo matched but failed a check — return that failure (don't keep scanning)
      return check;
    }

    if (memoHit) {
      return {
        ok: false,
        code: 'no_match',
        message: 'Memo matched but payment failed verification',
        payment: memoHit,
      };
    }

    return {
      ok: false,
      code: 'no_match',
      message: 'No Horizon payment matched this link memo',
    };
  }

  /** Re-run the seven checks against a single already-found record. */
  checkRecord(
    payment: Payment,
    record: HorizonPaymentRecord,
    knownHashes: Set<string>,
  ): VerifyResult {
    if (!record.successful) {
      return {
        ok: false,
        code: 'tx_unsuccessful',
        message: 'Transaction was not successful on Stellar',
        payment: record,
      };
    }

    // 1. destination
    if (record.to !== payment.destinationAddress) {
      return {
        ok: false,
        code: 'wrong_destination',
        message: `Destination ${record.to} does not match ${payment.destinationAddress}`,
        payment: record,
      };
    }

    // 2. asset code
    const expectedCode = payment.currency;
    const actualCode =
      record.assetType === 'native' ? 'XLM' : (record.assetCode ?? '');
    if (actualCode !== expectedCode) {
      return {
        ok: false,
        code: 'wrong_asset',
        message: `Expected asset ${expectedCode}, received ${actualCode || record.assetType}`,
        payment: record,
      };
    }

    // 3. asset issuer
    const expectedIssuer = this.expectedIssuer(
      payment.currency,
      payment.environment,
    );
    if (expectedIssuer === null) {
      if (record.assetIssuer !== null) {
        return {
          ok: false,
          code: 'wrong_issuer',
          message: 'Native XLM payment must not carry an issuer',
          payment: record,
        };
      }
    } else if (record.assetIssuer !== expectedIssuer) {
      return {
        ok: false,
        code: 'wrong_issuer',
        message: `Expected issuer ${expectedIssuer}, received ${record.assetIssuer ?? 'null'}`,
        payment: record,
      };
    }

    // 4. amount (exact decimal match)
    const cmp = compareDecimalStrings(record.amount, payment.amount);
    if (cmp < 0) {
      return {
        ok: false,
        code: 'insufficient_amount',
        message: `Received ${record.amount}, expected ${payment.amount}`,
        payment: record,
      };
    }
    if (cmp > 0) {
      return {
        ok: false,
        code: 'wrong_amount',
        message: `Received ${record.amount}, expected exact ${payment.amount}`,
        payment: record,
      };
    }

    // 5. memo
    if (record.memo !== payment.linkMemo) {
      return {
        ok: false,
        code: 'memo_mismatch',
        message: 'Memo does not match payment linkMemo',
        payment: record,
      };
    }

    // 6. duplicate transaction hash
    if (knownHashes.has(record.transactionHash)) {
      return {
        ok: false,
        code: 'duplicate_hash',
        message: `Transaction ${record.transactionHash} already attributed to another payment`,
        payment: record,
      };
    }

    // 7. ledger close time before expiresAt
    if (payment.expiresAt && record.createdAt > payment.expiresAt) {
      return {
        ok: false,
        code: 'expired',
        message: 'Payment arrived after expiresAt',
        payment: record,
      };
    }

    return { ok: true, payment: record };
  }

  expectedIssuer(
    currency: PaymentCurrency | string,
    environment: Environment,
  ): string | null {
    if (currency === 'XLM') return null;
    const stellar = this.config.get<StellarConfig>('stellar')!;
    const live = environment === 'live';
    if (currency === 'USDC') {
      return live ? stellar.usdcIssuerMainnet : stellar.usdcIssuerTestnet;
    }
    if (currency === 'EURC') {
      return live ? stellar.eurcIssuerMainnet : stellar.eurcIssuerTestnet;
    }
    return null;
  }
}
