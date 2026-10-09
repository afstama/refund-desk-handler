import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseInstant } from "../src/time.js";

const iso = (v: unknown) => parseInstant(v)?.toISOString();

describe("parseInstant", () => {
  test("offsets are turned into the same instant", () => {
    assert.equal(iso("2026-04-14T09:12:44+02:00"), "2026-04-14T07:12:44.000Z");
    assert.equal(iso("2026-04-14T09:12:44Z"), "2026-04-14T09:12:44.000Z");
    assert.equal(iso("2026-04-04T14:31:00-04:00"), "2026-04-04T18:31:00.000Z");
    assert.equal(iso("2026-04-10T21:30:00Z"), iso("2026-04-10T22:30:00+01:00"));
  });

  test("exactly 30 days apart across different offsets (R-0059)", () => {
    const delivered = parseInstant("2026-04-10T21:30:00Z")!;
    const refund = parseInstant("2026-05-10T23:30:00+02:00")!;
    assert.equal(refund.getTime() - delivered.getTime(), 30 * 24 * 3600 * 1000);
  });

  test("fractions and surrounding spaces", () => {
    assert.equal(iso("2026-04-14T09:12:44.5Z"), "2026-04-14T09:12:44.500Z");
    assert.equal(iso("2026-04-14T09:12:44.123456Z"), "2026-04-14T09:12:44.123Z");
    assert.equal(iso(" 2026-04-14T09:12:44Z "), "2026-04-14T09:12:44.000Z");
  });

  test("calendar is checked", () => {
    assert.equal(iso("2028-02-29T10:00:00Z"), "2028-02-29T10:00:00.000Z");
    assert.equal(iso("2026-02-29T10:00:00Z"), undefined);
    assert.equal(iso("2026-02-30T10:00:00Z"), undefined);
    assert.equal(iso("2026-04-31T10:00:00Z"), undefined);
    assert.equal(iso("2026-13-01T10:00:00Z"), undefined);
    assert.equal(iso("2026-04-14T24:00:00Z"), undefined);
    assert.equal(iso("2026-04-14T09:60:00Z"), undefined);
    assert.equal(iso("2026-04-14T09:12:60Z"), undefined);
    assert.equal(iso("2026-04-14T09:12:44+25:00"), undefined);
  });

  test("refuses anything that is not RFC 3339 with an offset", () => {
    for (const v of ["not-a-date", "", "2026-04-14T09:12:44", "2026-04-14 09:12:44Z", "2026-04-14", "14/04/2026", "0000-01-01T00:00:00Z", null, undefined, 1776000000, {}]) {
      assert.equal(parseInstant(v), null, String(JSON.stringify(v)));
    }
  });
});
