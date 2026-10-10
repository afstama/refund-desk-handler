const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

// Up to 9,999,999,999 whole units: with at most 4 decimals that is below 1e14, an exact integer in a JS number.
const MAX_WHOLE_DIGITS = 10;

/**
 * Reads an amount as whole minor units (cents, pence, yen), or returns null when it cannot be read.
 *
 * `digits` is the number of decimals of the amount's currency (see currency.ts): 2 for EUR, 0 for JPY, 3 for KWD.
 * Works on the digits as text, never with float arithmetic:
 *   - a JSON number becomes its text first (11.4 -> "11.4"), a string is trimmed, anything else is refused
 *   - the text must be digits with an optional decimal part (no sign, no comma, no exponent)
 *   - more decimals than the currency has are rounded half up: the first extra digit decides
 *   - the result must be greater than zero
 */
export function parseAmountMinor(value: unknown, digits = 2): number | null {
  let text: string;
  if (typeof value === "number") text = String(value);
  else if (typeof value === "string") text = value.trim();
  else return null;

  const match = AMOUNT.exec(text);
  if (!match) return null;

  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (whole.length > MAX_WHOLE_DIGITS) return null;
  const fraction = match[2] ?? "";

  const kept = digits > 0 ? Number(fraction.slice(0, digits).padEnd(digits, "0")) : 0;
  let minor = Number(whole) * 10 ** digits + kept;
  if (fraction.length > digits && fraction.charCodeAt(digits) >= 53 /* "5" */) minor += 1;
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}
