import { describe, expect, it } from "vitest";
import {
  avatarKey,
  buildInternalUrl,
  DEFAULT_SIZE,
  isValidHash,
  MAX_SIZE,
  MIN_SIZE,
  normalizeParams,
  ParamError,
  parseAvatarPath,
  parseInternalParams,
  parsePublicParams,
  parseSize,
} from "../src/params";

const MD5 = "e3f8b5dfe92c59253bda03568ec664d5";
const SHA256 =
  "27205e5c51cb03f862138b22bcb5dc20f94a342e744ff6df1b8dc8af3c865109";

describe("isValidHash", () => {
  it("accepts MD5 and SHA-256 hashes", () => {
    expect(isValidHash(MD5)).toBe(true);
    expect(isValidHash(SHA256)).toBe(true);
    expect(isValidHash(MD5.toUpperCase())).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidHash("")).toBe(false);
    expect(isValidHash("not-a-hash")).toBe(false);
    expect(isValidHash(MD5.slice(0, 31))).toBe(false);
    expect(isValidHash(`${MD5}0`)).toBe(false);
    expect(isValidHash("g".repeat(32))).toBe(false);
  });
});

describe("parseAvatarPath", () => {
  it("extracts the hash", () => {
    expect(parseAvatarPath(`/avatar/${MD5}`)).toBe(MD5);
    expect(parseAvatarPath(`/avatar/${SHA256}`)).toBe(SHA256);
    expect(parseAvatarPath(`/avatar/${MD5.toUpperCase()}`)).toBe(MD5);
  });

  it("accepts a trailing image extension", () => {
    expect(parseAvatarPath(`/avatar/${MD5}.jpg`)).toBe(MD5);
    expect(parseAvatarPath(`/avatar/${MD5}.png`)).toBe(MD5);
    expect(parseAvatarPath(`/avatar/${MD5}.jpeg`)).toBe(MD5);
  });

  it("accepts a trailing slash", () => {
    expect(parseAvatarPath(`/avatar/${MD5}/`)).toBe(MD5);
  });

  it("rejects other paths", () => {
    expect(parseAvatarPath("/")).toBeNull();
    expect(parseAvatarPath("/avatar/")).toBeNull();
    expect(parseAvatarPath(`/avatars/${MD5}`)).toBeNull();
    expect(parseAvatarPath(`/avatar/${MD5}.txt`)).toBeNull();
    expect(parseAvatarPath(`/avatar/${MD5}/extra`)).toBeNull();
  });
});

describe("parseSize", () => {
  it("defaults to 80", () => {
    expect(parseSize(null)).toBe(DEFAULT_SIZE);
    expect(parseSize(undefined)).toBe(DEFAULT_SIZE);
    expect(parseSize("")).toBe(DEFAULT_SIZE);
    expect(parseSize("abc")).toBe(DEFAULT_SIZE);
  });

  it("clamps to the accepted range", () => {
    expect(parseSize("0")).toBe(MIN_SIZE);
    expect(parseSize("-10")).toBe(MIN_SIZE);
    expect(parseSize(String(MAX_SIZE + 1))).toBe(MAX_SIZE);
    expect(parseSize("200")).toBe(200);
  });
});

describe("parsePublicParams", () => {
  it("normalizes rating, default and size", () => {
    const params = parsePublicParams(MD5, new URLSearchParams("s=80&r=G&d=IDENTICON"));
    expect(params).toEqual({
      hash: MD5,
      size: 80,
      default: "identicon",
      rating: "g",
      force: false,
      refresh: false,
    });
  });

  it("supports the long parameter names", () => {
    const params = parsePublicParams(
      MD5,
      new URLSearchParams("size=120&rating=PG&default=retro&force=y"),
    );
    expect(params.size).toBe(120);
    expect(params.rating).toBe("pg");
    expect(params.default).toBe("retro");
    expect(params.force).toBe(true);
  });

  it("prefers the short names when both are present", () => {
    const params = parsePublicParams(MD5, new URLSearchParams("s=40&size=200&r=x&rating=g"));
    expect(params.size).toBe(40);
    expect(params.rating).toBe("x");
  });

  it("treats an absent default as Gravatar's own default", () => {
    expect(parsePublicParams(MD5, new URLSearchParams()).default).toBe("");
  });

  it("rejects an unsupported default image", () => {
    expect(() => parsePublicParams(MD5, new URLSearchParams("d=nope"))).toThrow(ParamError);
    try {
      parsePublicParams(MD5, new URLSearchParams("d=nope"));
    } catch (error) {
      expect((error as ParamError).code).toBe("INVALID_DEFAULT");
    }
  });

  it("rejects an unsupported rating", () => {
    expect(() => parsePublicParams(MD5, new URLSearchParams("r=z"))).toThrow(ParamError);
    try {
      parsePublicParams(MD5, new URLSearchParams("r=z"));
    } catch (error) {
      expect((error as ParamError).code).toBe("INVALID_RATING");
    }
  });

  it("rejects an invalid hash", () => {
    expect(() => parsePublicParams("nope", new URLSearchParams())).toThrow(ParamError);
  });
});

describe("avatarKey", () => {
  it("is stable across equivalent spellings", () => {
    const a = parsePublicParams(MD5, new URLSearchParams("s=80&r=G&d=identicon"));
    const b = parsePublicParams(MD5, new URLSearchParams("size=80&rating=g&default=IDENTICON"));
    expect(avatarKey(a)).toBe(avatarKey(b));
    expect(avatarKey(a)).toBe(`${MD5}:80:identicon:g:0`);
  });

  it("distinguishes a missing default from a built-in one", () => {
    const a = parsePublicParams(MD5, new URLSearchParams());
    const b = parsePublicParams(MD5, new URLSearchParams("d=mp"));
    expect(avatarKey(a)).toBe(`${MD5}:80:-:g:0`);
    expect(avatarKey(b)).toBe(`${MD5}:80:mp:g:0`);
  });
});

describe("internal URL", () => {
  it("round-trips every parameter", () => {
    const params = normalizeParams({
      hash: MD5,
      size: "200",
      default: "identicon",
      rating: "pg",
      force: "1",
      refresh: "1",
    });

    const url = buildInternalUrl(params);
    expect(url.origin).toBe("https://gravatar.internal");
    expect(url.pathname).toBe("/v1/avatar");

    const parsed = parseInternalParams(url.searchParams);
    expect(parsed).toEqual(params);
  });

  it("round-trips the absent default", () => {
    const params = normalizeParams({ hash: MD5 });
    const parsed = parseInternalParams(buildInternalUrl(params).searchParams);
    expect(parsed?.default).toBe("");
  });

  it("rejects a malformed internal request", () => {
    expect(parseInternalParams(new URLSearchParams())).toBeNull();
    expect(parseInternalParams(new URLSearchParams("h=nope"))).toBeNull();
    expect(parseInternalParams(new URLSearchParams(`h=${MD5}&d=nope`))).toBeNull();
  });
});
