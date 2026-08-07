import { generateId, idGeneratorProvider, ID_GENERATOR, PREFIXES } from '@/common/utils/id-generator';

describe('id-generator', () => {
  describe('generateId()', () => {
    it('generates an id with the given prefix', () => {
      const id = generateId('pay');
      expect(id).toMatch(/^pay_[0-9A-Z]{26}$/);
    });

    it('generates unique ids on successive calls', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId('pay')));
      expect(ids.size).toBe(100);
    });

    it('supports all defined prefixes', () => {
      for (const prefix of Object.values(PREFIXES)) {
        const id = generateId(prefix);
        expect(id.startsWith(`${prefix}_`)).toBe(true);
      }
    });

    it('throws for an empty prefix', () => {
      expect(() => generateId('')).toThrow('ID prefix must be a non-empty string');
    });

    it('throws for a whitespace-only prefix', () => {
      expect(() => generateId('   ')).toThrow('ID prefix must be a non-empty string');
    });

    it('preserves the prefix exactly (no trimming)', () => {
      const id = generateId('we');
      expect(id).toMatch(/^we_/);
    });

    it('the ULID portion is 26 chars long', () => {
      const id = generateId('cus');
      const ulidPart = id.split('_')[1];
      expect(ulidPart).toHaveLength(26);
    });

    it('generates lexicographically sortable ids over time', async () => {
      const id1 = generateId('evt');
      await new Promise((r) => setTimeout(r, 2));
      const id2 = generateId('evt');
      expect(id1 < id2).toBe(true);
    });
  });

  describe('PREFIXES constant', () => {
    it('defines all expected prefixes', () => {
      expect(PREFIXES.PAYMENT).toBe('pay');
      expect(PREFIXES.CUSTOMER).toBe('cus');
      expect(PREFIXES.EVENT).toBe('evt');
      expect(PREFIXES.API_KEY).toBe('key');
      expect(PREFIXES.WEBHOOK_ENDPOINT).toBe('we');
      expect(PREFIXES.WEBHOOK_DELIVERY).toBe('whd');
      expect(PREFIXES.REQUEST).toBe('req');
    });
  });

  describe('idGeneratorProvider', () => {
    it('has the correct injection token', () => {
      expect(idGeneratorProvider.provide).toBe(ID_GENERATOR);
    });

    it('useFactory returns a function', () => {
      const factory = idGeneratorProvider.useFactory;
      const fn = factory();
      expect(typeof fn).toBe('function');
    });

    it('the returned function generates valid ids', () => {
      const factory = idGeneratorProvider.useFactory;
      const fn = factory();
      const id = fn('req');
      expect(id).toMatch(/^req_[0-9A-Z]{26}$/);
    });
  });
});
