/**
 * Amount utilities for the HyperTone Payments API.
 *
 * IMPORTANT: Never use JavaScript `number` / `parseFloat` / `Number()` for
 * payment amounts. This module uses integer arithmetic on scaled values to
 * avoid all floating-point precision issues.
 *
 * Supported currencies and their maximum decimal precision:
 *   USDC → 7 decimal places
 *   EURC → 7 decimal places
 *   XLM  → 7 decimal places
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SupportedCurrency = 'USDC' | 'EURC' | 'XLM';

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum decimal precision allowed per currency. */
export const CURRENCY_MAX_PRECISION: Record<SupportedCurrency, number> = {
  USDC: 7,
  EURC: 7,
  XLM: 7,
};

/**
 * Regex that matches a valid positive decimal string.
 *
 * Rules enforced:
 *  - No leading whitespace or trailing whitespace
 *  - No scientific notation (no `e` / `E`)
 *  - No leading zeros on the integer part (e.g. `01.5` is invalid)
 *  - A single optional decimal point
 *  - At least one digit before the decimal point
 *  - At least one digit after the decimal point if a point is present
 */
const DECIMAL_STRING_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

// ─── Validation ──────────────────────────────────────────────────────────────────

/**
 * Returns `true` if `value` is a valid positive (non-zero, non-negative)
 * decimal string with no scientific notation, leading zeros, or whitespace.
 */
export function isValidDecimalString(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!DECIMAL_STRING_REGEX.test(value)) return false;

  // Reject zero and negative zero
  const [intPart, fracPart] = value.split('.');
  const isIntZero = intPart === '0';
  const isFracAllZeros = fracPart !== undefined && /^0+$/.test(fracPart);

  if (isIntZero && (fracPart === undefined || isFracAllZeros)) return false;

  return true;
}

/**
 * Returns `true` if the decimal string's fractional precision does not
 * exceed `maxDecimals`.
 *
 * Assumes `value` has already been validated with `isValidDecimalString`.
 */
export function checkPrecision(value: string, maxDecimals: number): boolean {
  const dotIndex = value.indexOf('.');
  if (dotIndex === -1) return true; // integer — always within precision
  const decimals = value.length - dotIndex - 1;
  return decimals <= maxDecimals;
}

/**
 * Returns the maximum allowed decimal precision for a given currency.
 */
export function currencyMaxPrecision(currency: SupportedCurrency): number {
  return CURRENCY_MAX_PRECISION[currency];
}

/**
 * Validates `value` as a payment amount for the specified currency.
 * Combines format validation and precision checking.
 */
export function isValidPaymentAmount(
  value: string,
  currency: SupportedCurrency,
): boolean {
  if (!isValidDecimalString(value)) return false;
  return checkPrecision(value, currencyMaxPrecision(currency));
}

// ─── Arithmetic ───────────────────────────────────────────────────────────────────

/**
 * Adds two non-negative decimal strings and returns the result as a decimal
 * string, using integer arithmetic scaled to the maximum precision of the
 * two operands.
 *
 * Both operands must be non-negative (including `"0"`).
 * The result is normalised to remove trailing zeros after the decimal point,
 * but always has at least one digit before the decimal point.
 *
 * @example
 * addDecimalStrings('1.5', '2.35')  // → '3.85'
 * addDecimalStrings('0.1', '0.2')   // → '0.3'
 * addDecimalStrings('10', '5')      // → '15'
 */
export function addDecimalStrings(a: string, b: string): string {
  validateNonNegativeDecimal(a, 'a');
  validateNonNegativeDecimal(b, 'b');

  const precA = decimalPlaces(a);
  const precB = decimalPlaces(b);
  const prec = Math.max(precA, precB);

  // Scale both values to integers with the same precision
  const scaledA = scale(a, prec);
  const scaledB = scale(b, prec);

  const sumScaled = scaledA + scaledB;

  return descaleAndNormalize(sumScaled, prec);
}

/**
 * Compares two non-negative decimal strings.
 * Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  validateNonNegativeDecimal(a, 'a');
  validateNonNegativeDecimal(b, 'b');

  const prec = Math.max(decimalPlaces(a), decimalPlaces(b));
  const scaledA = scale(a, prec);
  const scaledB = scale(b, prec);

  if (scaledA < scaledB) return -1;
  if (scaledA > scaledB) return 1;
  return 0;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────────

/** Returns the number of digits after the decimal point. */
function decimalPlaces(value: string): number {
  const idx = value.indexOf('.');
  return idx === -1 ? 0 : value.length - idx - 1;
}

/**
 * Scales a decimal string to a BigInt multiplied by 10^precision.
 * Avoids floating-point by doing pure string manipulation.
 */
function scale(value: string, precision: number): bigint {
  const [intPart, fracPart = ''] = value.split('.');
  // Pad or trim the fractional part to match the target precision
  const paddedFrac = fracPart.padEnd(precision, '0').slice(0, precision);
  return BigInt(intPart + paddedFrac);
}

/**
 * Converts a BigInt scaled value back to a normalised decimal string.
 * Removes trailing zeros after the decimal point.
 */
function descaleAndNormalize(scaled: bigint, precision: number): string {
  if (precision === 0) return scaled.toString();

  const divisor = 10n ** BigInt(precision);
  const intPart = (scaled / divisor).toString();
  const fracRemainder = scaled % divisor;
  const fracStr = fracRemainder.toString().padStart(precision, '0');

  // Remove trailing zeros
  const trimmed = fracStr.replace(/0+$/, '');
  return trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
}

/** Validates that a value is a non-negative decimal string (includes "0"). */
function validateNonNegativeDecimal(value: string, paramName: string): void {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new Error(
      `addDecimalStrings: parameter '${paramName}' must be a non-negative decimal string, got: ${JSON.stringify(value)}`,
    );
  }
}
