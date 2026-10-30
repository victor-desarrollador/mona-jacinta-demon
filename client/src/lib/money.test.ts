import { describe, expect, it } from "vitest";
import { arsToCents, centsToArsInput, cents, formatMoney, formatSignedMoney } from "./money";

// Characterization of the money helpers exactly as they behaved inside page.tsx before they were moved here
// (golden values taken from that code, es-AR currency format: U+00A0 after "$").
const NBSP = " ";

describe("formatMoney (exact BigInt centavos, never Number)", () => {
  it.each([
    ["0", `$${NBSP}0`],
    ["1", `$${NBSP}0,01`],
    ["5", `$${NBSP}0,05`],
    ["99", `$${NBSP}0,99`],
    ["100", `$${NBSP}1`],
    ["950000", `$${NBSP}9.500`],
    ["1209", `$${NBSP}12,09`],
    ["120940", `$${NBSP}1.209,40`],
    ["-120940", `-$${NBSP}1.209,40`],
    ["-5", `-$${NBSP}0,05`],
    ["100000000000000000", `$${NBSP}1.000.000.000.000.000`],
    ["9007199254740993", `$${NBSP}90.071.992.547.409,93`],
    ["123456789012345678901", `$${NBSP}1.234.567.890.123.456.789,01`],
  ])("formats %s", (input, expected) => {
    expect(formatMoney(input)).toBe(expected);
  });

  it("formatSignedMoney is formatMoney", () => {
    expect(formatSignedMoney("-120940")).toBe(formatMoney("-120940"));
  });

  it("cents is BigInt of the decimal string", () => {
    expect(cents("9007199254740993")).toBe(BigInt("9007199254740993"));
  });
});

describe("centsToArsInput (exact prefill)", () => {
  it.each([
    ["0", "0"],
    ["1", "0,01"],
    ["5", "0,05"],
    ["99", "0,99"],
    ["100", "1"],
    ["950000", "9500"],
    ["1209", "12,09"],
    ["120940", "1209,40"],
    ["-120940", "-1209,40"],
    ["-5", "-0,05"],
    ["100000000000000000", "1000000000000000"],
    ["9007199254740993", "90071992547409,93"],
    ["123456789012345678901", "1234567890123456789,01"],
  ])("prefills %s", (input, expected) => {
    expect(centsToArsInput(input)).toBe(expected);
  });
});

describe("arsToCents (operator input -> centavos string or null)", () => {
  it.each([
    ["1.209,40", "120940"],
    ["1209,40", "120940"],
    ["1,209.40", "120940"],
    ["9.500", "950000"],
    ["9500", "950000"],
    ["0,01", "1"],
    ["0.01", "1"],
    ["1.2.3", "1230"],
    ["12,345", "1234500"],
    ["12,3", "1230"],
    ["12,", "1200"],
    ["1 000", "100000"],
    ["1.000.000,5", "100000050"],
  ])("parses %j", (input, expected) => {
    expect(arsToCents(input)).toBe(expected);
  });

  it.each(["", "  ", "abc", "-5", "1e3", "０１"])("rejects %j", (input) => {
    expect(arsToCents(input)).toBeNull();
  });

  it("round-trips whole and fractional prefills", () => {
    for (const value of ["0", "1", "99", "100", "120940", "9007199254740993"]) {
      expect(arsToCents(centsToArsInput(value))).toBe(value);
    }
  });
});
