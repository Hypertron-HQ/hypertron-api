/**
 * Integration tests for ReconcilerService with mocked Horizon + Prisma.
 *
 * Covers Plan §19.5:
 *  - match → confirmed → completed
 *  - wrong asset → failed
 *  - insufficient amount → failed
 *  - expired → expired
 *  - duplicate hash → skip
 *  - concurrent confirm → only one wins (CAS)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentStatus } from '@prisma/client';
import type { Payment } from '@prisma/client';

import { ReconcilerService } from '@/modules/reconciler/reconciler.service';
import { StellarVerifier } from '@/modules/reconciler/stellar-verifier';
import { PaymentStateMachine } from '@/modules/payments/payment-state-machine';
import { EventsService } from '@/modules/events/events.service';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { StellarHorizonService } from '@/infrastructure/stellar/stellar-horizon.service';
import { RECONCILER_QUEUE } from '@/modules/reconciler/reconciler.constants';
import {
  DEFAULT_USDC_ISSUER_TESTNET,
} from '@/common/config/stellar.config';
import type { HorizonPaymentRecord } from '@/infrastructure/stellar/stellar-horizon.service';

const DEST = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PAYER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZFOZ3GJJKM9MST9LNKLYA';
const MEMO = 'hpl_recon_1';

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'oid_pay_1',
    publicId: 'pay_recon_1',
    businessId: 'biz_1',
    environment: 'test',
    status: PaymentStatus.pending,
    amount: '1.00',
    currency: 'XLM',
    description: null,
    customerId: 'oid_cus_1',
    metadata: {},
    checkoutUrl: 'http://localhost:3000/pay/link1',
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

function makeXlmRecord(
  overrides: Partial<HorizonPaymentRecord> = {},
): HorizonPaymentRecord {
  return {
    id: 'op_1',
    transactionHash: 'abc123txhash',
    from: PAYER,
    to: DEST,
    amount: '1.00',
    assetType: 'native',
    assetCode: 'XLM',
    assetIssuer: null,
    createdAt: new Date(),
    memo: MEMO,
    memoType: 'text',
    successful: true,
    ...overrides,
  };
}

describe('ReconcilerService (integration)', () => {
  let service: ReconcilerService;
  let payment: Payment;
  let horizonPayments: HorizonPaymentRecord[];
  let foreignHashes: { transactionHash: string }[];
  let queueAdd: jest.Mock;
  let paymentLinkUpdate: jest.Mock;
  let customerUpdate: jest.Mock;
  let customerFind: jest.Mock;
  let eventsEmit: jest.Mock;

  beforeEach(async () => {
    payment = makePayment();
    horizonPayments = [makeXlmRecord()];
    foreignHashes = [];
    queueAdd = jest.fn().mockResolvedValue({});
    paymentLinkUpdate = jest.fn().mockResolvedValue({});
    customerUpdate = jest.fn().mockResolvedValue({});
    customerFind = jest.fn().mockResolvedValue({
      id: 'oid_cus_1',
      lifetimeValue: '0.00',
    });
    eventsEmit = jest.fn().mockResolvedValue({ id: 'evt_1' });

    const prisma = {
      payment: {
        findUnique: jest.fn().mockImplementation(async () => ({ ...payment })),
        findMany: jest.fn().mockImplementation(async (args: {
          where?: { transactionHash?: { in?: string[] }; status?: unknown };
        }) => {
          if (args.where?.transactionHash?.in) {
            return foreignHashes.filter((r) =>
              args.where!.transactionHash!.in!.includes(r.transactionHash),
            );
          }
          if (args.where?.status === PaymentStatus.pending ||
              (args.where?.status as { in?: PaymentStatus[] })?.in) {
            return payment.status === PaymentStatus.pending ||
              payment.status === PaymentStatus.created
              ? [{ ...payment }]
              : [];
          }
          return [];
        }),
        updateMany: jest.fn().mockImplementation(
          async (args: {
            where: {
              status?: { in?: PaymentStatus[] };
              transactionHash?: null;
            };
            data: Partial<Payment>;
          }) => {
            const allowed = args.where.status?.in ?? [];
            if (allowed.length && !allowed.includes(payment.status)) {
              return { count: 0 };
            }
            if (
              'transactionHash' in args.where &&
              args.where.transactionHash === null &&
              payment.transactionHash !== null
            ) {
              return { count: 0 };
            }
            Object.assign(payment, args.data);
            return { count: 1 };
          },
        ),
      },
      paymentLink: { update: paymentLinkUpdate },
      customer: {
        findUnique: customerFind,
        update: customerUpdate,
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconcilerService,
        StellarVerifier,
        PaymentStateMachine,
        {
          provide: EventsService,
          useValue: { emit: eventsEmit },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: StellarHorizonService,
          useValue: {
            listPaymentsForAccount: jest
              .fn()
              .mockImplementation(async () => horizonPayments),
            getTransaction: jest.fn().mockImplementation(async (hash: string) => ({
              hash,
              successful: true,
              ledger: 1,
            })),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'stellar') {
                return {
                  usdcIssuerTestnet: DEFAULT_USDC_ISSUER_TESTNET,
                  usdcIssuerMainnet: DEFAULT_USDC_ISSUER_TESTNET,
                  eurcIssuerTestnet: DEFAULT_USDC_ISSUER_TESTNET,
                  eurcIssuerMainnet: DEFAULT_USDC_ISSUER_TESTNET,
                  finalityDelayMs: 100,
                  reconcilerLookback: 50,
                };
              }
              return undefined;
            },
          },
        },
        {
          provide: getQueueToken(RECONCILER_QUEUE),
          useValue: { add: queueAdd },
        },
      ],
    }).compile();

    service = module.get(ReconcilerService);
  });

  it('matching Horizon payment → confirmed + PaymentLink sync + finality job', async () => {
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('confirmed');
    expect(payment.status).toBe(PaymentStatus.confirmed);
    expect(payment.transactionHash).toBe('abc123txhash');
    expect(paymentLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'link_1' },
        data: expect.objectContaining({ paymentTxHash: 'abc123txhash' }),
      }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'finality-check',
      { paymentInternalId: 'oid_pay_1' },
      expect.objectContaining({ jobId: 'finality_oid_pay_1' }),
    );
  });

  it('finality check → completed + customer aggregate', async () => {
    payment.status = PaymentStatus.confirmed;
    payment.transactionHash = 'abc123txhash';
    payment.paidAt = new Date();
    payment.currency = 'USDC';
    payment.amount = '5.00';

    const outcome = await service.finalizePayment(payment.id);
    expect(outcome).toBe('completed');
    expect(payment.status).toBe(PaymentStatus.completed);
    expect(customerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentCount: { increment: 1 },
          lifetimeValue: '5',
        }),
      }),
    );
  });

  it('wrong asset → failed', async () => {
    payment.currency = 'USDC';
    payment.amount = '10.00';
    horizonPayments = [
      makeXlmRecord({
        amount: '10.00',
        assetType: 'credit_alphanum4',
        assetCode: 'EURC',
        assetIssuer: DEFAULT_USDC_ISSUER_TESTNET,
      }),
    ];

    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('failed');
    expect(payment.status).toBe(PaymentStatus.failed);
    expect(payment.failureCode).toBe('wrong_asset');
  });

  it('insufficient amount → failed', async () => {
    horizonPayments = [makeXlmRecord({ amount: '0.50' })];
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('failed');
    expect(payment.failureCode).toBe('insufficient_amount');
  });

  it('expired ledger time → expired', async () => {
    payment.expiresAt = new Date('2020-01-01T00:00:00Z');
    horizonPayments = [
      makeXlmRecord({ createdAt: new Date('2020-06-01T00:00:00Z') }),
    ];
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('expired');
    expect(payment.status).toBe(PaymentStatus.expired);
  });

  it('duplicate hash → skipped (no fail)', async () => {
    foreignHashes = [{ transactionHash: 'abc123txhash' }];
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('skipped');
    expect(payment.status).toBe(PaymentStatus.pending);
  });

  it('concurrent confirm: second CAS loses → skipped', async () => {
    // First confirm succeeds
    await service.reconcilePayment(payment);
    expect(payment.status).toBe(PaymentStatus.confirmed);

    // Reset status to pending but keep hash — simulates race after first writer
    payment.status = PaymentStatus.pending;
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('skipped');
  });

  it('no matching memo → no_match', async () => {
    horizonPayments = [makeXlmRecord({ memo: 'hpl_other' })];
    const outcome = await service.reconcilePayment(payment);
    expect(outcome).toBe('no_match');
    expect(payment.status).toBe(PaymentStatus.pending);
  });
});
