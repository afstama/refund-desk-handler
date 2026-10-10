// Decimal places of a currency's minor unit (ISO 4217). Most currencies have 2, so 2 is the default and only the
// exceptions are listed. Used to read amounts the way the sender wrote them and to show them the same way.
const ZERO = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"];
const THREE = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const FOUR = ["CLF", "UYW"];

export const DEFAULT_MINOR_UNIT_DIGITS = 2;

/** Only the exceptions to the default. This table is also sent to the screen. */
export const CURRENCY_DIGITS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([...ZERO.map((c) => [c, 0]), ...THREE.map((c) => [c, 3]), ...FOUR.map((c) => [c, 4])]),
);

export function minorUnitDigits(currency: string): number {
  return Object.hasOwn(CURRENCY_DIGITS, currency) ? CURRENCY_DIGITS[currency]! : DEFAULT_MINOR_UNIT_DIGITS;
}
