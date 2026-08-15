import {
  isValidDecimalString,
  checkPrecision,
  currencyMaxPrecision,
  isValidPaymentAmount,
  addDecimalStrings,
  compareDecimalStrings,
  CURRENCY_MAX_PRECISION,
} from '@/common/utils/amount.util';

// ─── isValidDecimalString ─────────────────────────────────────────────────────

describe('isValidDecimalString()', () => {
  describe('valid inputs', () => {
    it.each([
      ['1'],
      ['10'],
      ['100'],
      ['1.0'],
      ['1.5'],
      ['0.1'],
      ['0.00000001'],
      ['9999999.9999999'],
      ['1234567.1234567'],
      ['100.00'],
    ])('accepts %s', (value) => {
      expect(isValidDecimalString(value)).toBe(true);
    });
  });

  describe('invalid inputs — zero / negative', () => {
    it.each([['0'], ['0.0'], ['0.00'], ['00'], ['-1'], ['-0.5']])(
      'rejects %s',
      (value) => {
        expect(isValidDecimalString(value)).toBe(false);
      },
    );
  });

  describe('invalid inputs — format issues', () => {
    it.each([
      ['1e5'],
      ['1E5'],
      ['1.5e2'],
      ['01.5'],
      ['001'],
      ['.5'],
      ['1.'],
      ['1,5'],
      ['$1.00'],
      [' 1.00'],
      ['1.00 '],
      ['1 .00'],
      [''],
      ['abc'],
      ['NaN'],
      ['Infinity'],
      ['-Infinity'],
      ['1.2.3'],
    ])('rejects %s', (value) => {
      expect(isValidDecimalString(value)).toBe(false);
    });
  });

  describe('non-string inputs', () => {
    it.each([
      [1 as unknown as string],
      [null as unknown as string],
      [undefined as unknown as string],
      [[] as unknown as string],
    ])('rejects non-string %p', (value) => {
      expect(isValidDecimalString(value)).toBe(false);
    });
  });
});

// ─── checkPrecision ───────────────────────────────────────────────────────────

describe('checkPrecision()', () => {
  it('returns true for an integer (no decimal part)', () => {
    expect(checkPrecision('100', 7)).toBe(true);
  });

  it('returns true when decimal places equal maxDecimals', () => {
    expect(checkPrecision('1.1234567', 7)).toBe(true);
  });

  it('returns true when decimal places are below maxDecimals', () => {
    expect(checkPrecision('1.12', 7)).toBe(true);
  });

  it('returns false when decimal places exceed maxDecimals', () => {
    expect(checkPrecision('1.12345678', 7)).toBe(false);
  });

  it('returns true for maxDecimals = 0 with no decimal', () => {
    expect(checkPrecision('5', 0)).toBe(true);
  });

  it('returns false for maxDecimals = 0 with any decimal', () => {
    expect(checkPrecision('5.1', 0)).toBe(false);
  });
});

// ─── currencyMaxPrecision ─────────────────────────────────────────────────────

describe('currencyMaxPrecision()', () => {
  it('returns 7 for USDC', () => {
    expect(currencyMaxPrecision('USDC')).toBe(7);
  });

  it('returns 7 for EURC', () => {
    expect(currencyMaxPrecision('EURC')).toBe(7);
  });

  it('returns 7 for XLM', () => {
    expect(currencyMaxPrecision('XLM')).toBe(7);
  });

  it('is consistent with CURRENCY_MAX_PRECISION constant', () => {
    for (const [currency, max] of Object.entries(CURRENCY_MAX_PRECISION)) {
      expect(currencyMaxPrecision(currency as 'USDC' | 'EURC' | 'XLM')).toBe(
        max,
      );
    }
  });
});

// ─── isValidPaymentAmount ─────────────────────────────────────────────────────

describe('isValidPaymentAmount()', () => {
  it('accepts a valid USDC amount with 7 decimal places', () => {
    expect(isValidPaymentAmount('1.1234567', 'USDC')).toBe(true);
  });

  it('rejects a USDC amount with 8 decimal places', () => {
    expect(isValidPaymentAmount('1.12345678', 'USDC')).toBe(false);
  });

  it('accepts a valid integer amount', () => {
    expect(isValidPaymentAmount('100', 'XLM')).toBe(true);
  });

  it('rejects zero', () => {
    expect(isValidPaymentAmount('0', 'USDC')).toBe(false);
  });

  it('rejects a negative value', () => {
    expect(isValidPaymentAmount('-1', 'USDC')).toBe(false);
  });

  it('rejects scientific notation', () => {
    expect(isValidPaymentAmount('1e5', 'EURC')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidPaymentAmount('', 'USDC')).toBe(false);
  });
});

// ─── addDecimalStrings ────────────────────────────────────────────────────────

describe('addDecimalStrings()', () => {
  describe('basic addition', () => {
    it.each([
      ['1', '2', '3'],
      ['1.5', '2.5', '4'],
      ['0.1', '0.2', '0.3'],
      ['10', '5', '15'],
      ['0', '0', '0'],
      ['0', '1', '1'],
      ['1', '0', '1'],
      ['0.1', '0.9', '1'],
      ['1.5', '2.35', '3.85'],
      ['0.0000001', '0.0000001', '0.0000002'],
      ['100.0000000', '200.0000000', '300'],
      ['9999999.9999999', '0.0000001', '10000000'],
      ['1.23', '4.56789', '5.79789'],
    ])('addDecimalStrings(%s, %s) === %s', (a, b, expected) => {
      expect(addDecimalStrings(a, b)).toBe(expected);
    });
  });

  describe('trailing zero normalisation', () => {
    it('strips trailing zeros after decimal point', () => {
      expect(addDecimalStrings('1.50', '2.50')).toBe('4');
    });

    it('keeps meaningful decimals', () => {
      expect(addDecimalStrings('1.50', '0.05')).toBe('1.55');
    });
  });

  describe('error handling', () => {
    it('throws for non-string input a', () => {
      expect(() => addDecimalStrings(1 as unknown as string, '2')).toThrow();
    });

    it('throws for non-string input b', () => {
      expect(() =>
        addDecimalStrings('1', undefined as unknown as string),
      ).toThrow();
    });

    it('throws for scientific notation in a', () => {
      expect(() => addDecimalStrings('1e5', '1')).toThrow();
    });

    it('throws for scientific notation in b', () => {
      expect(() => addDecimalStrings('1', '2e3')).toThrow();
    });

    it('throws for a negative value in a', () => {
      expect(() => addDecimalStrings('-1', '2')).toThrow();
    });

    it('throws for a negative value in b', () => {
      expect(() => addDecimalStrings('1', '-2')).toThrow();
    });

    it('throws for empty string a', () => {
      expect(() => addDecimalStrings('', '1')).toThrow();
    });
  });
});

// ─── compareDecimalStrings ────────────────────────────────────────────────────

describe('compareDecimalStrings()', () => {
  it('returns 0 when values are equal (integers)', () => {
    expect(compareDecimalStrings('10', '10')).toBe(0);
  });

  it('returns 0 when values are equal (decimals)', () => {
    expect(compareDecimalStrings('1.5', '1.5')).toBe(0);
  });

  it('returns 0 when values are equal with different precisions', () => {
    expect(compareDecimalStrings('1.50', '1.5')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareDecimalStrings('1', '2')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareDecimalStrings('2', '1')).toBe(1);
  });

  it('handles decimal comparison correctly', () => {
    expect(compareDecimalStrings('0.1', '0.2')).toBe(-1);
    expect(compareDecimalStrings('0.9', '1.0')).toBe(-1);
    expect(compareDecimalStrings('1.0000001', '1.0000000')).toBe(1);
  });

  it('compares zero correctly', () => {
    expect(compareDecimalStrings('0', '0')).toBe(0);
    expect(compareDecimalStrings('0', '1')).toBe(-1);
    expect(compareDecimalStrings('1', '0')).toBe(1);
  });

  it('throws for invalid input a', () => {
    expect(() => compareDecimalStrings('-1', '1')).toThrow();
  });

  it('throws for invalid input b', () => {
    expect(() => compareDecimalStrings('1', 'abc')).toThrow();
  });
});
