import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAmountMinor } from "../src/money.js";

describe("parseAmountMinor", () => {
  test("reads clean amounts as whole minor units", () => {
    const cases: [unknown, number][] = [
      ["29.97", 2997],
      ["9.99", 999],
      ["18", 1800],
      ["18.4", 1840],
      ["20.00", 2000],
      ["20.01", 2001],
      ["0.01", 1],
      ["007.50", 750],
      ["9999999999.99", 999999999999],
    ];
    for (const [input, expected] of cases) assert.equal(parseAmountMinor(input), expected, JSON.stringify(input));
  });

  test("real values from the data: trim the space, accept the JSON number", () => {
    assert.equal(parseAmountMinor(" 18.40"), 1840); // evt_0389
    assert.equal(parseAmountMinor(11.4), 1140); // evt_0357
  });

  test("a JSON number goes through its text, so float noise does not matter", () => {
    assert.equal(parseAmountMinor(19.99), 1999);
    assert.equal(parseAmountMinor(0.1 + 0.2), 30); // 0.30000000000000004
    assert.equal(parseAmountMinor(20), 2000);
  });

  test("more than two decimals are rounded half up to the cent", () => {
    const cases: [string, number | null][] = [
      ["10.999", 1100],
      ["10.995", 1100],
      ["10.994", 1099],
      ["10.9949999", 1099],
      ["1.005", 101], // the classic float trap: 1.005 * 100 is 100.49999999999999
      ["0.005", 1],
      ["0.004", null], // rounds to zero, and a refund must be greater than zero
      ["20.004", 2000],
      ["20.005", 2001],
    ];
    for (const [input, expected] of cases) assert.equal(parseAmountMinor(input), expected, input);
  });

  test("refuses what would have to be guessed", () => {
    const bad: unknown[] = [
      "13,40", // evt_0124, decimal comma is locale dependent
      "abc", // evt_0212
      "-15.00", // evt_0350
      "",
      "   ",
      "0",
      "0.00",
      "1e3",
      "0x10",
      ".5",
      "5.",
      "1.2.3",
      "+5",
      "11.4abc",
      "1 000",
      "12345678901.00", // more than 10 whole digits
      null,
      undefined,
      true,
      [11.4],
      { amount: 1 },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -5,
      1e21,
      5e-7,
    ];
    for (const input of bad) assert.equal(parseAmountMinor(input), null, String(JSON.stringify(input)));
  });
});
