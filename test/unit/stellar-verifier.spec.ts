/**
 * Unit tests for StellarVerifier — all seven checks + failure codes (Plan §19.2 / §19.5).
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus } from '@prisma/client';
import type { Payment } from '@prisma/client';

import { StellarVerifier } from '@/modules/reconciler/stellar-verifier';
import type { HorizonPaymentRecord } from '@/infrastructure/stellar/stellar-horizon.service';
import {
  DEFAULT_USDC_ISSUER_TESTNET,
  DEFAULT_USDC_ISSUER_MAINNET,
} from '@/common/config/stellar.config';

const DEST = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const MEMO = 'hpl_test_memo_001';
const USDC_ISSUER = DEFAULT_USDC_ISSUER_TESTNET;
const PAYER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZFOZ3GJJKM9MST9LNKLYA';
const OTHER = 'GDQNY3PBOJOKYZSRMKJCQZQBN6UZ6SJSMLSY6VAU3NQPXQHJIMMSXKZG';

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_internal_1',
    publicId: 'pay_01',
    businessId: 'biz_1',
    environment: 'test',
    status: PaymentStatus.pending,
    amount: '10.00',
    currency: 'USDC',
    description: null,
    customerId: null,
    metadata: {},
    checkoutUrl: 'http://localhost:3000/pay/x',
    paymentLinkId: 'link_1',
    linkMemo: MEMO,
    destinationAddress: DEST,
    payerAddress: null,
    transactionHash: null,
    assetIssuer: null,
    failureCode: null,
    failureMessage: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    paidAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<HorizonPaymentRecord> = {},
): HorizonPaymentRecord {
  return {
    id: 'op_1',
    transactionHash: 'txhash_abc',
    from: PAYER,
    to: DEST,
    amount: '10.00',
    assetType: 'credit_alphanum4',
    assetCode: 'USDC',
    assetIssuer: USDC_ISSUER,
    createdAt: new Date(),
    memo: MEMO,
    memoType: 'text',
    successful: true,
    ...overrides,
  };
}

describe('StellarVerifier', () => {
  let verifier: StellarVerifier;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        StellarVerifier,
        {
          provide: ConfigService,
          useValue: {
            get: () => ({
              usdcIssuerTestnet: DEFAULT_USDC_ISSUER_TESTNET,
              usdcIssuerMainnet: DEFAULT_USDC_ISSUER_MAINNET,
              eurcIssuerTestnet: DEFAULT_USDC_ISSUER_TESTNET,
              eurcIssuerMainnet: DEFAULT_USDC_ISSUER_MAINNET,
            }),
          },
        },
      ],
    }).compile();
    verifier = module.get(StellarVerifier);
  });

  it('accepts a fully matching USDC payment', () => {
    const result = verifier.verify(makePayment(), [makeRecord()], new Set());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.transactionHash).toBe('txhash_abc');
    }
  });

  it('accepts native XLM with null issuer', () => {
    const payment = makePayment({ currency: 'XLM', amount: '1.5' });
    const record = makeRecord({
      amount: '1.5',
      assetType: 'native',
      assetCode: 'XLM',
      assetIssuer: null,
    });
    const result = verifier.verify(payment, [record], new Set());
    expect(result.ok).toBe(true);
  });

  it('fails wrong_asset', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord({ assetCode: 'EURC' })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_asset');
  });

  it('fails wrong_issuer', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord({ assetIssuer: OTHER })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_issuer');
  });

  it('fails insufficient_amount', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord({ amount: '9.99' })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('insufficient_amount');
  });

  it('fails wrong_amount when overpaid', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord({ amount: '10.01' })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_amount');
  });

  it('fails wrong_destination', () => {
    const result = verifier.verify(
      makePayment(),
      [
        makeRecord({
          to: OTHER,
        }),
      ],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_destination');
  });

  it('fails expired when ledger time is after expiresAt', () => {
    const expiresAt = new Date('2020-01-01T00:00:00Z');
    const result = verifier.verify(
      makePayment({ expiresAt }),
      [makeRecord({ createdAt: new Date('2020-01-02T00:00:00Z') })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired');
  });

  it('fails duplicate_hash', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord()],
      new Set(['txhash_abc']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('duplicate_hash');
  });

  it('ignores unrelated memos (no_match)', () => {
    const result = verifier.verify(
      makePayment(),
      [makeRecord({ memo: 'hpl_other' })],
      new Set(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_match');
  });

  it('treats decimal-equivalent amounts as equal (10.00 vs 10)', () => {
    const result = verifier.verify(
      makePayment({ amount: '10.00' }),
      [makeRecord({ amount: '10' })],
      new Set(),
    );
    expect(result.ok).toBe(true);
  });

  it('uses mainnet issuer when environment is live', () => {
    const payment = makePayment({ environment: 'live' });
    const result = verifier.verify(
      payment,
      [makeRecord({ assetIssuer: DEFAULT_USDC_ISSUER_MAINNET })],
      new Set(),
    );
    expect(result.ok).toBe(true);
  });
});
