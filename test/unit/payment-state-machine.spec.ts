/**
 * Unit tests for PaymentStateMachine.
 *
 * Covers:
 *  - All valid transitions succeed
 *  - All invalid transitions throw StateTransitionException
 *  - Terminal states reject further transitions
 *  - Atomic compare-and-set no-op on race condition (already in target state)
 *  - Lifecycle timestamps are set correctly
 *  - EventsService.emit is called with the correct event type
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus } from '@prisma/client';
import type { Payment } from '@prisma/client';

import { PaymentStateMachine } from '@/modules/payments/payment-state-machine';
import { EventsService } from '@/modules/events/events.service';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { StateTransitionException } from '@/common/exceptions/hypertron.exception';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0;
function makePayment(status: PaymentStatus, overrides: Partial<Payment> = {}): Payment {
  idCounter++;
  return {
    id: `id_${idCounter}`,
    publicId: `pay_${idCounter}`,
    businessId: 'biz_001',
    environment: 'test',
    status,
    amount: '10.00',
    currency: 'USDC',
    description: null,
    customerId: null,
    metadata: {},
    checkoutUrl: 'https://pay.example.com/pay/pay_1',
    paymentLinkId: `pay_${idCounter}`,
    linkMemo: `hpl_abc${idCounter}`,
    destinationAddress: 'GTEST',
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

// ─── Mocks ────────────────────────────────────────────────────────────────────

function buildMockPrisma(payment: Payment) {
  // Simulate updateMany modifying the in-memory payment
  const updateMany = jest.fn().mockImplementation(
    async (args: {
      where: { status?: { in?: PaymentStatus[] }; transactionHash?: null };
      data: Partial<Payment>;
    }) => {
      const allowed = args.where.status?.in ?? [];
      if (allowed.length > 0 && !allowed.includes(payment.status)) {
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
  );

  const findUnique = jest.fn().mockImplementation(async () => ({ ...payment }));

  return {
    payment: { updateMany, findUnique },
  };
}

const mockEvents = {
  emit: jest.fn().mockResolvedValue({ id: 'evt_1', type: 'payment.pending' }),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PaymentStateMachine', () => {
  let machine: PaymentStateMachine;

  async function buildModule(payment: Payment) {
    jest.clearAllMocks();
    const prisma = buildMockPrisma(payment);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentStateMachine,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsService, useValue: mockEvents },
      ],
    }).compile();

    return module.get<PaymentStateMachine>(PaymentStateMachine);
  }

  // ─── toPending ────────────────────────────────────────────────────────────

  describe('toPending()', () => {
    it('transitions created → pending', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      const result = await machine.toPending(p.id);
      expect(result.status).toBe(PaymentStatus.pending);
    });

    it('emits payment.pending event', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      await machine.toPending(p.id);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.pending }),
        'payment.pending',
      );
    });

    it('throws StateTransitionException from pending', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      await expect(machine.toPending(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws StateTransitionException from completed', async () => {
      const p = makePayment(PaymentStatus.completed);
      machine = await buildModule(p);
      await expect(machine.toPending(p.id)).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── toConfirmed ──────────────────────────────────────────────────────────

  describe('toConfirmed()', () => {
    const tx = {
      transactionHash: 'tx_abc123',
      payerAddress: 'GPAYER',
      assetIssuer: 'GCIRCLE',
    };

    it('transitions pending → confirmed', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      const result = await machine.toConfirmed(p.id, tx);
      expect(result.status).toBe(PaymentStatus.confirmed);
    });

    it('sets paidAt timestamp', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      const result = await machine.toConfirmed(p.id, tx);
      expect(result.paidAt).not.toBeNull();
    });

    it('emits payment.confirmed event', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      await machine.toConfirmed(p.id, tx);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.anything(),
        'payment.confirmed',
      );
    });

    it('throws from created (must be pending first)', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      await expect(machine.toConfirmed(p.id, tx)).rejects.toThrow(StateTransitionException);
    });

    it('throws from completed (terminal)', async () => {
      const p = makePayment(PaymentStatus.completed);
      machine = await buildModule(p);
      await expect(machine.toConfirmed(p.id, tx)).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── toCompleted ──────────────────────────────────────────────────────────

  describe('toCompleted()', () => {
    it('transitions confirmed → completed', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      const result = await machine.toCompleted(p.id);
      expect(result.status).toBe(PaymentStatus.completed);
    });

    it('sets completedAt timestamp', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      const result = await machine.toCompleted(p.id);
      expect(result.completedAt).not.toBeNull();
    });

    it('emits payment.completed event', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      await machine.toCompleted(p.id);
      expect(mockEvents.emit).toHaveBeenCalledWith(expect.anything(), 'payment.completed');
    });

    it('throws from pending (must be confirmed first)', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      await expect(machine.toCompleted(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws from created', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      await expect(machine.toCompleted(p.id)).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── toFailed ─────────────────────────────────────────────────────────────

  describe('toFailed()', () => {
    it('transitions pending → failed', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      const result = await machine.toFailed(p.id, 'wrong_asset', 'Wrong asset received');
      expect(result.status).toBe(PaymentStatus.failed);
    });

    it('transitions confirmed → failed', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      const result = await machine.toFailed(p.id, 'timeout', 'Timeout');
      expect(result.status).toBe(PaymentStatus.failed);
    });

    it('emits payment.failed event', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      await machine.toFailed(p.id, 'code', 'msg');
      expect(mockEvents.emit).toHaveBeenCalledWith(expect.anything(), 'payment.failed');
    });

    it('throws from created', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      await expect(machine.toFailed(p.id, 'x', 'y')).rejects.toThrow(StateTransitionException);
    });

    it('throws from completed (terminal)', async () => {
      const p = makePayment(PaymentStatus.completed);
      machine = await buildModule(p);
      await expect(machine.toFailed(p.id, 'x', 'y')).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── toExpired ────────────────────────────────────────────────────────────

  describe('toExpired()', () => {
    it('transitions created → expired', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      const result = await machine.toExpired(p.id);
      expect(result.status).toBe(PaymentStatus.expired);
    });

    it('transitions pending → expired', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      const result = await machine.toExpired(p.id);
      expect(result.status).toBe(PaymentStatus.expired);
    });

    it('emits payment.expired event', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      await machine.toExpired(p.id);
      expect(mockEvents.emit).toHaveBeenCalledWith(expect.anything(), 'payment.expired');
    });

    it('throws from confirmed', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      await expect(machine.toExpired(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws from completed (terminal)', async () => {
      const p = makePayment(PaymentStatus.completed);
      machine = await buildModule(p);
      await expect(machine.toExpired(p.id)).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── toCanceled ───────────────────────────────────────────────────────────

  describe('toCanceled()', () => {
    it('transitions created → canceled', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      const result = await machine.toCanceled(p.id);
      expect(result.status).toBe(PaymentStatus.canceled);
    });

    it('transitions pending → canceled', async () => {
      const p = makePayment(PaymentStatus.pending);
      machine = await buildModule(p);
      const result = await machine.toCanceled(p.id);
      expect(result.status).toBe(PaymentStatus.canceled);
    });

    it('sets canceledAt timestamp', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      const result = await machine.toCanceled(p.id);
      expect(result.canceledAt).not.toBeNull();
    });

    it('emits payment.canceled event', async () => {
      const p = makePayment(PaymentStatus.created);
      machine = await buildModule(p);
      await machine.toCanceled(p.id);
      expect(mockEvents.emit).toHaveBeenCalledWith(expect.anything(), 'payment.canceled');
    });

    it('throws from confirmed', async () => {
      const p = makePayment(PaymentStatus.confirmed);
      machine = await buildModule(p);
      await expect(machine.toCanceled(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws from completed (terminal)', async () => {
      const p = makePayment(PaymentStatus.completed);
      machine = await buildModule(p);
      await expect(machine.toCanceled(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws from failed (terminal)', async () => {
      const p = makePayment(PaymentStatus.failed);
      machine = await buildModule(p);
      await expect(machine.toCanceled(p.id)).rejects.toThrow(StateTransitionException);
    });

    it('throws from expired (terminal)', async () => {
      const p = makePayment(PaymentStatus.expired);
      machine = await buildModule(p);
      await expect(machine.toCanceled(p.id)).rejects.toThrow(StateTransitionException);
    });
  });

  // ─── Race condition (compare-and-set no-op) ───────────────────────────────

  describe('race condition / compare-and-set', () => {
    it('returns existing payment if already in target state (idempotent no-op)', async () => {
      const p = makePayment(PaymentStatus.created);
      const prisma = buildMockPrisma(p);

      // First findUnique call → returns 'created' (current state check)
      // updateMany returns count=0 (lost the race)
      // Second findUnique call → returns 'pending' (already transitioned by winner)
      const pendingSnapshot = { ...p, status: PaymentStatus.pending };
      prisma.payment.findUnique
        .mockResolvedValueOnce({ ...p })         // first call: pre-transition check
        .mockResolvedValueOnce(pendingSnapshot);  // second call: reload after race

      prisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PaymentStateMachine,
          { provide: PrismaService, useValue: prisma },
          { provide: EventsService, useValue: mockEvents },
        ],
      }).compile();

      machine = module.get<PaymentStateMachine>(PaymentStateMachine);
      const result = await machine.toPending(p.id);
      expect(result.status).toBe(PaymentStatus.pending);
    });

    it('throws if payment not found', async () => {
      const p = makePayment(PaymentStatus.created);
      const prisma = buildMockPrisma(p);
      prisma.payment.findUnique.mockResolvedValue(null);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PaymentStateMachine,
          { provide: PrismaService, useValue: prisma },
          { provide: EventsService, useValue: mockEvents },
        ],
      }).compile();

      machine = module.get<PaymentStateMachine>(PaymentStateMachine);
      await expect(machine.toPending(p.id)).rejects.toThrow(StateTransitionException);
    });
  });
});
