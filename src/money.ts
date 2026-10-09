const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

// Up to 9,999,999,999.99 in one currency: keeps every minor-unit value an exact integer in a JS number.
const MAX_WHOLE_DIGITS = 10;

/**
 * Reads an amount as whole minor units (cents, pence), or returns null when it cannot be read.
 *
 * Works on the digits as text, never with float arithmetic:
 *   - a JSON number becomes its text first (11.4 -> "11.4"), a string is trimmed, anything else is refused
 *   - the text must be digits with an optional decimal part (no sign, no comma, no exponent)
 *   - more than two decimals are rounded half up to the cent: the third digit decides
 *   - the result must be greater than zero
 * Assumes two minor-unit digits, which holds for EUR, USD and GBP.
 */
export function parseAmountMinor(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") text = String(value);
  else if (typeof value === "string") text = value.trim();
  else return null;

  const match = AMOUNT.exec(text);
  if (!match) return null;

  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (whole.length > MAX_WHOLE_DIGITS) return null;
  const fraction = match[2] ?? "";

  let minor = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
  if (fraction.length > 2 && fraction.charCodeAt(2) >= 53 /* "5" */) minor += 1;
  return minor > 0 ? minor : null;
}
