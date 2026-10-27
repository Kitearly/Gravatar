import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  kvKeyFail,
  kvKeyLast,
  kvKeyNow,
  randomNowTtlSeconds,
  readAvatar,
  readFail,
  writeAvatar,
  writeFail,
} from "../src/kv";
import type { AvatarMeta, Env } from "../src/types";

const workerEnv = env as unknown as Env;

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** Bytes that are not valid UTF-8 and would be destroyed by a text read. */
const BINARY = Uint8Array.from([
  0x00, 0x01, 0xff, 0xfe, 0x80, 0x9f, 0xc3, 0x28, 0xed, 0xa0, 0x80,
]);

const META: AvatarMeta = {
  ct: "image/png",
  url: "https://gravatar.com/avatar/example",
  at: 1_761_000_000_000,
};

describe("key helpers", () => {
  it("builds the three keys of a variant", () => {
    expect(kvKeyNow("abc:80:-:g:0")).toBe("av:now:abc:80:-:g:0");
    expect(kvKeyLast("abc:80:-:g:0")).toBe("av:last:abc:80:-:g:0");
    expect(kvKeyFail("abc:80:-:g:0")).toBe("fail:abc:80:-:g:0");
  });
});

describe("randomNowTtlSeconds", () => {
  it("picks a lifetime between three and seven days", () => {
    for (let i = 0; i < 200; i += 1) {
      const ttl = randomNowTtlSeconds();
      expect(ttl).toBeGreaterThanOrEqual(3 * 24 * 3600);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
    }
  });

  it("actually spreads the values out", () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i += 1) values.add(randomNowTtlSeconds());
    expect(values.size).toBeGreaterThan(10);
  });
});

describe("readAvatar", () => {
  it("returns null for a missing key", async () => {
    expect(await readAvatar(workerEnv, "av:now:missing.example", 60)).toBeNull();
  });
});

describe("writeAvatar", () => {
  it("stores and reads an avatar with its metadata", async () => {
    const key = kvKeyNow("roundtrip.example");
    expect(await writeAvatar(workerEnv, key, PNG, META, 600)).toBe(true);

    const read = await readAvatar(workerEnv, key, 60);
    expect(read).not.toBeNull();
    expect(read?.bytes).toEqual(PNG);
    expect(read?.meta).toEqual(META);
  });

  it("keeps bytes that are not valid UTF-8 intact", async () => {
    const key = kvKeyNow("binary.example");
    await writeAvatar(workerEnv, key, BINARY, META, 600);

    const read = await readAvatar(workerEnv, key, 60);
    expect(read?.bytes).toEqual(BINARY);
  });

  it("writes an entry that never expires", async () => {
    const key = kvKeyLast("forever.example");
    expect(await writeAvatar(workerEnv, key, PNG, META, null)).toBe(true);
    expect(await readAvatar(workerEnv, key, 60)).not.toBeNull();
  });

  it("ignores an entry without metadata", async () => {
    const key = kvKeyNow("nometa.example");
    await workerEnv.GRAVATAR_KV.put(key, PNG, { expirationTtl: 600 });
    expect(await readAvatar(workerEnv, key, 60)).toBeNull();
  });

  it("ignores metadata that is not an image", async () => {
    const key = kvKeyNow("badtype.example");
    await workerEnv.GRAVATAR_KV.put(key, PNG, {
      expirationTtl: 600,
      metadata: { ct: "text/html", url: "https://x.test/", at: Date.now() },
    });
    expect(await readAvatar(workerEnv, key, 60)).toBeNull();
  });

  it("ignores metadata without a write time", async () => {
    const key = kvKeyNow("noat.example");
    await workerEnv.GRAVATAR_KV.put(key, PNG, {
      expirationTtl: 600,
      metadata: { ct: "image/png", url: "https://x.test/" },
    });
    expect(await readAvatar(workerEnv, key, 60)).toBeNull();
  });
});

describe("negative cache", () => {
  it("stores and reads a failure reason", async () => {
    const key = kvKeyFail("missing.example");
    expect(await writeFail(workerEnv, key, "404", 600)).toBe(true);
    expect(await readFail(workerEnv, key)).toBe("404");
  });

  it("returns null for a missing failure", async () => {
    expect(await readFail(workerEnv, "fail:absent.example")).toBeNull();
  });
});
