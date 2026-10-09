const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Reads an RFC 3339 timestamp that carries an offset ("2026-04-14T09:12:44+02:00", "...Z") as an instant.
 * Returns null for anything else, including impossible dates such as 2026-02-30.
 * Offsets vary between events, so always compare the returned instants, never the text.
 */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = RFC3339.exec(value.trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  const zone = m[8]!;
  if (zone !== "Z") {
    const offsetHour = Number(m[9]);
    const offsetMinute = Number(m[10]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const instant = new Date(date.getTime() - offsetMinutes * 60_000);

  // Postgres timestamptz cannot store year 0 or years above 9999.
  const y = instant.getUTCFullYear();
  return y >= 1 && y <= 9999 ? instant : null;
}
