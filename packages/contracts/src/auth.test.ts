import { describe, expect, it } from "vitest";

import {
  countCodePoints,
  emailSchema,
  hasUnpairedSurrogate,
  normalizeEmail,
  passwordByteLength,
  passwordSchema,
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_MIN_CODE_POINTS,
  registerRequestSchema,
} from "./auth.js";

describe("normalizeEmail", () => {
  it("trims and lowercases, and nothing else", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("does not apply Unicode normalisation", () => {
    // `é` composed (U+00E9) and decomposed (U+0065 U+0301) stay distinct.
    expect(normalizeEmail("Jos\u00e9@example.com")).toBe("jos\u00e9@example.com");
    expect(normalizeEmail("Jose\u0301@example.com")).toBe("jose\u0301@example.com");
  });
});

describe("emailSchema", () => {
  it("normalises before validating", () => {
    expect(emailSchema.parse("  Mixed@Case.Example ")).toBe("mixed@case.example");
  });

  it("rejects a value that is not an address", () => {
    expect(emailSchema.safeParse("not-an-address").success).toBe(false);
    expect(emailSchema.safeParse("").success).toBe(false);
  });
});

describe("countCodePoints", () => {
  it("counts an astral character once", () => {
    expect(countCodePoints("\u{1F600}")).toBe(1);
    expect("\u{1F600}".length).toBe(2);
  });

  it("counts a combining sequence as separate code points", () => {
    expect(countCodePoints("e\u0301")).toBe(2);
  });
});

describe("hasUnpairedSurrogate", () => {
  it("accepts well-formed text", () => {
    expect(hasUnpairedSurrogate("plain")).toBe(false);
    expect(hasUnpairedSurrogate("\u{1F600}")).toBe(false);
  });

  it("detects a lone high surrogate", () => {
    expect(hasUnpairedSurrogate("a\uD800b")).toBe(true);
  });

  it("detects a lone low surrogate", () => {
    expect(hasUnpairedSurrogate("a\uDC00b")).toBe(true);
  });
});

describe("passwordSchema", () => {
  it("accepts exactly the minimum number of code points", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_CODE_POINTS)).success).toBe(true);
  });

  it("rejects one code point short", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_CODE_POINTS - 1)).success).toBe(false);
  });

  it("counts astral characters as one code point", () => {
    const twelveEmoji = "\u{1F600}".repeat(PASSWORD_MIN_CODE_POINTS);
    expect(countCodePoints(twelveEmoji)).toBe(PASSWORD_MIN_CODE_POINTS);
    expect(passwordSchema.safeParse(twelveEmoji).success).toBe(true);
    expect(passwordSchema.safeParse("\u{1F600}".repeat(PASSWORD_MIN_CODE_POINTS - 1)).success).toBe(
      false,
    );
  });

  it("does not count UTF-16 code units as characters", () => {
    // Six astral characters are twelve code units and six code points.
    const sixEmoji = "\u{1F601}".repeat(6);
    expect(sixEmoji.length).toBe(12);
    expect(passwordSchema.safeParse(sixEmoji).success).toBe(false);
  });

  it("accepts exactly the maximum number of UTF-8 bytes", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_UTF8_BYTES)).success).toBe(true);
  });

  it("rejects one byte over the maximum", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_UTF8_BYTES + 1)).success).toBe(false);
  });

  it("applies the byte limit independently of the code-point count", () => {
    const twoByte = "\u00e9";
    expect(passwordByteLength(twoByte.repeat(512))).toBe(1024);
    expect(passwordSchema.safeParse(twoByte.repeat(512)).success).toBe(true);
    expect(passwordSchema.safeParse(twoByte.repeat(513)).success).toBe(false);
  });

  it("rejects an unpaired high and low surrogate", () => {
    expect(passwordSchema.safeParse(`${"a".repeat(12)}\uD800`).success).toBe(false);
    expect(passwordSchema.safeParse(`${"a".repeat(12)}\uDC00`).success).toBe(false);
  });

  it("preserves whitespace and never trims", () => {
    const spaced = "  password1234  ";
    const parsed = passwordSchema.parse(spaced);
    expect(parsed).toBe(spaced);
    expect(parsed.startsWith(" ")).toBe(true);
    expect(parsed.endsWith(" ")).toBe(true);
  });

  it("applies no Unicode normalisation", () => {
    const decomposed = "e\u0301".repeat(6);
    expect(passwordSchema.parse(decomposed)).toBe(decomposed);
  });
});

describe("registerRequestSchema", () => {
  it("normalises the email and keeps the password exact", () => {
    const parsed = registerRequestSchema.parse({
      email: "  User@Example.com ",
      password: "correct horse battery staple",
    });
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.password).toBe("correct horse battery staple");
  });

  it("rejects unknown keys instead of ignoring them", () => {
    const result = registerRequestSchema.safeParse({
      email: "user@example.com",
      password: "correct horse battery staple",
      role: "admin",
    });
    expect(result.success).toBe(false);
  });
});
