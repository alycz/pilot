import { describe, expect, it } from "vitest";

import {
  bpsCeil,
  divideFloor,
  FIXED_SCALE,
  formatFixed,
  multiplyFloor,
  parseFixed,
} from "./fixed-point";

describe("fixed-point decimal accounting", () => {
  it("parses and formats canonical decimals without floating-point conversion", () => {
    expect(formatFixed(parseFixed("123.450000000001"))).toBe("123.450000000001");
    expect(formatFixed(parseFixed("0"))).toBe("0");
    expect(formatFixed(-parseFixed("0.25"))).toBe("-0.25");
  });

  it("uses deterministic floor and conservative cost rounding", () => {
    expect(formatFixed(multiplyFloor(parseFixed("3.25"), parseFixed("2")))).toBe("6.5");
    expect(formatFixed(divideFloor(parseFixed("1"), parseFixed("3")))).toBe("0.333333333333");
    expect(formatFixed(bpsCeil(1n, 1))).toBe("0.000000000001");
    expect(FIXED_SCALE).toBe(1_000_000_000_000n);
  });

  it("rejects noncanonical, over-precise, and unbounded inputs", () => {
    for (const invalid of ["-1", "+1", "01", "1e3", " 1", "1.", ".1", "NaN"]) {
      expect(() => parseFixed(invalid)).toThrow(/canonical nonnegative decimal/);
    }
    expect(() => parseFixed("0.0000000000001")).toThrow(/12 decimal/);
    expect(() => parseFixed("1000000000000000001")).toThrow(/range/);
  });
});
