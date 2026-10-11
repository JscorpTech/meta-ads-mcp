import { describe, expect, it } from "vitest";
import { readSpendCap } from "../../src/meta/spend-cap.js";

describe("readSpendCap", () => {
  // Meta sends "0" for an ad account without a cap.
  it.each([["0"], ["0.00"], [0]])("reads the explicit zero %j as no cap", (raw) => {
    expect(readSpendCap(raw)).toEqual({ state: "none" });
  });

  it.each([
    ["100000", 100000],
    [100000, 100000],
    ["1", 1],
    ["2350.5", 2350.5],
  ])("reads the positive number %j as a cap", (raw, minor) => {
    expect(readSpendCap(raw)).toEqual({ state: "set", minor });
  });

  // Neither a cap nor its absence: the field says nothing. One value per row,
  // so that an array is passed as a value and not spread into arguments.
  it.each([
    [undefined],
    [null],
    [""],
    [" "],
    [" 0"],
    ["abc"],
    ["-5"],
    [-5],
    ["1e3"],
    ["0x10"],
    ["1,000"],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [false],
    [true],
    [[]],
    [[0]],
    [{}],
  ])("reads %j as unknown", (raw) => {
    expect(readSpendCap(raw)).toEqual({ state: "unknown" });
  });

  // "No cap" needs a zero that was written as one: a positive decimal too
  // small for a double becomes 0 on conversion.
  it("does not read a positive decimal that underflows to zero as no cap", () => {
    expect(readSpendCap(`0.${"0".repeat(323)}1`)).toEqual({ state: "unknown" });
  });
});
