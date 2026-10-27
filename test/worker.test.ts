import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { kvKeyLast, kvKeyNow, readAvatar, writeAvatar } from "../src/kv";
import { avatarKey, normalizeParams } from "../src/params";
import type { AvatarMeta, Env } from "../src/types";
import { network } from "./setup";

const workerEnv = env as unknown as Env;

/** A real 1x1 PNG. */
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const PNG = toArrayBuffer(PNG_BYTES);

const MAIN = "e3f8b5dfe92c59253bda03568ec664d5";
const BOTH = "ffffffffffffffffffffffffffffffff";
const SECOND = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SIZE = "11111111111111111111111111111111";
const RATING = "22222222222222222222222222222222";
const NOT_FOUND = "33333333333333333333333333333333";
const REFRESH_404 = "12121212121212121212121212121212";
const STALE = "44444444444444444444444444444444";
const FAILURE = "55555555555555555555555555555555";
const REFRESH = "66666666666666666666666666666666";
const HTML = "77777777777777777777777777777777";
const LARGE = "88888888888888888888888888888888";
const HOSTS = "99999999999999999999999999999999";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUFFIX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEFAULT = "cccccccccccccccccccccccccccccccc";
const ETAG = "dddddddddddddddddddddddddddddddd";

const META: AvatarMeta = {
  ct: "image/png",
  url: `https://gravatar.com/avatar/${STALE}`,
  at: Date.now(),
};

let upstreamCalls = 0;
let lastUpstreamUrl: URL | null = null;

/** The environment the tests run with. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...workerEnv,
    HOSTS: "",
    ALLOW_EMPTY_REFERER: "1",
    KV_EDGE_TTL_SECONDS: "60",
    MAX_AVATAR_BYTES: "1048576",
    FETCH_TIMEOUT_MS: "2000",
    // 默认在网关里进程内调用 Gravatar 入口：这样每个用例对 env 的覆盖
    // 才能传到内层（loopback 入口拿到的是运行时的 env，不是用例传的）。
    WORKERS_CACHE: "",
    ...overrides,
  } as Env;
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://worker.test${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

interface MockOptions {
  body?: ArrayBuffer;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
}

/** Mock one avatar request. The handler records what Gravatar was asked for. */
function mockAvatar(hash: string, options: MockOptions = {}): void {
  network.use(
    http.get(`https://gravatar.com/avatar/${hash}`, ({ request }) => {
      upstreamCalls += 1;
      lastUpstreamUrl = new URL(request.url);

      const status = options.status ?? 200;
      if (status !== 200) {
        return new HttpResponse(null, { status, headers: options.headers });
      }

      return HttpResponse.arrayBuffer(options.body ?? PNG, {
        headers: {
          "content-type": options.contentType ?? "image/png",
          ...options.headers,
        },
      });
    }),
  );
}

/** Store an avatar under `av:last` only, as if `av:now` had expired. */
async function seedLast(hash: string, bytes: Uint8Array, meta: AvatarMeta): Promise<void> {
  const params = normalizeParams({
    hash,
    size: "80",
    default: "identicon",
    rating: "g",
  });
  await writeAvatar(workerEnv, kvKeyLast(avatarKey(params)), bytes, meta, null);
}

beforeEach(() => {
  upstreamCalls = 0;
  lastUpstreamUrl = null;
  // Catch-all first, specific handlers below take precedence.
  network.use(http.all("*", () => new HttpResponse(null, { status: 404 })));
});

describe("fetching an avatar", () => {
  it("returns the avatar from Gravatar", async () => {
    mockAvatar(MAIN, {
      headers: {
        etag: '"abc"',
        "last-modified": "Fri, 08 May 2026 14:58:31 GMT",
      },
    });

    const response = await call(makeEnv(), `/avatar/${MAIN}?s=80&r=G&d=identicon`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-gravatar-cache")).toBe("MISS");
    expect(response.headers.get("x-gravatar-final-url")).toContain(
      `https://gravatar.com/avatar/${MAIN}`,
    );
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(response.headers.get("last-modified")).toBe("Fri, 08 May 2026 14:58:31 GMT");
    expect(response.headers.get("cache-tag")).toBe(`gravatar, gravatar:${MAIN}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);

    expect(lastUpstreamUrl?.searchParams.get("s")).toBe("80");
    expect(lastUpstreamUrl?.searchParams.get("r")).toBe("g");
    expect(lastUpstreamUrl?.searchParams.get("d")).toBe("identicon");
  });

  it("stores the avatar under both keys", async () => {
    mockAvatar(BOTH);
    await call(makeEnv(), `/avatar/${BOTH}?s=80&r=G&d=identicon`);

    const params = normalizeParams({
      hash: BOTH,
      size: "80",
      default: "identicon",
      rating: "g",
    });
    const key = avatarKey(params);

    const now = await readAvatar(workerEnv, kvKeyNow(key), 60);
    const last = await readAvatar(workerEnv, kvKeyLast(key), 60);

    expect(now?.bytes).toEqual(PNG_BYTES);
    expect(now?.meta.ct).toBe("image/png");
    expect(last?.bytes).toEqual(PNG_BYTES);
    expect(last?.meta).toEqual(now?.meta);
  });

  it("serves the stored avatar on the next request", async () => {
    mockAvatar(SECOND);

    const first = await call(makeEnv(), `/avatar/${SECOND}?s=80&r=G&d=identicon`);
    expect(first.headers.get("x-gravatar-cache")).toBe("MISS");

    const second = await call(makeEnv(), `/avatar/${SECOND}?s=80&r=G&d=identicon`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-gravatar-cache")).toBe("FRESH");
    expect(upstreamCalls).toBe(1);
  });

  it("answers HEAD requests without a body", async () => {
    mockAvatar(HEAD);

    const response = await call(makeEnv(), `/avatar/${HEAD}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("");
  });

  it("answers CORS preflight requests", async () => {
    const response = await call(makeEnv(), `/avatar/${MAIN}`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("accepts a file extension on the path", async () => {
    mockAvatar(SUFFIX);

    const response = await call(makeEnv(), `/avatar/${SUFFIX}.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("passes Gravatar's own default through when d is absent", async () => {
    mockAvatar(DEFAULT);

    await call(makeEnv(), `/avatar/${DEFAULT}`);
    expect(lastUpstreamUrl?.searchParams.has("d")).toBe(false);
    expect(lastUpstreamUrl?.searchParams.get("s")).toBe("80");
    expect(lastUpstreamUrl?.searchParams.get("r")).toBe("g");
    expect(lastUpstreamUrl?.searchParams.has("f")).toBe(false);
  });

  it("keeps etag and last-modified on a cache hit", async () => {
    mockAvatar(ETAG, {
      headers: {
        etag: '"xyz"',
        "last-modified": "Fri, 08 May 2026 14:58:31 GMT",
      },
    });

    const first = await call(makeEnv(), `/avatar/${ETAG}?d=identicon`);
    expect(first.headers.get("etag")).toBe('"xyz"');
    expect(first.headers.get("last-modified")).toBe("Fri, 08 May 2026 14:58:31 GMT");

    const second = await call(makeEnv(), `/avatar/${ETAG}?d=identicon`);
    expect(second.headers.get("x-gravatar-cache")).toBe("FRESH");
    expect(second.headers.get("etag")).toBe('"xyz"');
    expect(second.headers.get("last-modified")).toBe("Fri, 08 May 2026 14:58:31 GMT");
  });
});

describe("parameter handling", () => {
  it("clamps the size and normalizes the rating", async () => {
    mockAvatar(SIZE);

    await call(makeEnv(), `/avatar/${SIZE}?s=0&r=G&d=identicon&f=y`);
    expect(lastUpstreamUrl?.searchParams.get("s")).toBe("1");
    expect(lastUpstreamUrl?.searchParams.get("r")).toBe("g");
    expect(lastUpstreamUrl?.searchParams.get("d")).toBe("identicon");
    expect(lastUpstreamUrl?.searchParams.get("f")).toBe("y");

    await call(makeEnv(), `/avatar/${SIZE}?s=9999&r=G&d=identicon&refresh=1`);
    expect(lastUpstreamUrl?.searchParams.get("s")).toBe("2048");

    await call(makeEnv(), `/avatar/${SIZE}?s=abc&r=G&d=identicon&refresh=1`);
    expect(lastUpstreamUrl?.searchParams.get("s")).toBe("80");
  });

  it("normalizes an uppercase rating", async () => {
    mockAvatar(RATING);

    await call(makeEnv(), `/avatar/${RATING}?r=G&d=identicon`);
    expect(lastUpstreamUrl?.searchParams.get("r")).toBe("g");
  });

  it("rejects an invalid hash", async () => {
    const response = await call(makeEnv(), "/avatar/not-a-hash");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_HASH");
  });

  it("rejects an unsupported default image", async () => {
    const response = await call(makeEnv(), `/avatar/${MAIN}?d=nope`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_DEFAULT");
  });

  it("rejects an unsupported rating", async () => {
    const response = await call(makeEnv(), `/avatar/${MAIN}?r=z`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_RATING");
  });

  it("rejects methods other than GET, HEAD and OPTIONS", async () => {
    const response = await call(makeEnv(), `/avatar/${MAIN}`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("missing avatars", () => {
  it("returns 404 and caches the negative result", async () => {
    mockAvatar(NOT_FOUND, { status: 404 });

    const first = await call(makeEnv(), `/avatar/${NOT_FOUND}?d=404`);
    expect(first.status).toBe(404);
    expect(first.headers.get("x-gravatar-cache")).toBe("MISS");
    const body = (await first.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(upstreamCalls).toBe(1);

    const second = await call(makeEnv(), `/avatar/${NOT_FOUND}?d=404`);
    expect(second.status).toBe(404);
    expect(second.headers.get("x-gravatar-cache")).toBe("NEGATIVE");
    expect(upstreamCalls).toBe(1);
  });

  it("ignores the negative cache when refresh=1", async () => {
    mockAvatar(REFRESH_404, { status: 404 });

    await call(makeEnv(), `/avatar/${REFRESH_404}?d=404`);
    const refreshed = await call(makeEnv(), `/avatar/${REFRESH_404}?d=404&refresh=1`);
    expect(refreshed.status).toBe(404);
    expect(upstreamCalls).toBe(2);
  });
});

describe("when the current copy is gone", () => {
  it("serves the last copy and refreshes in the background", async () => {
    const old = Uint8Array.from(PNG_BYTES);
    old[old.length - 1] = 0x00;
    await seedLast(STALE, old, { ...META, url: `https://gravatar.com/avatar/${STALE}/old` });

    mockAvatar(STALE, { status: 500 });

    const response = await call(makeEnv(), `/avatar/${STALE}?d=identicon`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-gravatar-cache")).toBe("STALE");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);
  });

  it("returns 502 when there is nothing to fall back to", async () => {
    mockAvatar(FAILURE, { status: 500 });

    const response = await call(makeEnv(), `/avatar/${FAILURE}?d=identicon`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("does not negative-cache a transient upstream failure", async () => {
    mockAvatar(FAILURE, { status: 500 });

    await call(makeEnv(), `/avatar/${FAILURE}?d=identicon`);
    await call(makeEnv(), `/avatar/${FAILURE}?d=identicon`);
    expect(upstreamCalls).toBe(2);
  });
});

describe("refresh", () => {
  it("bypasses the cache and is not stored by the edge", async () => {
    mockAvatar(REFRESH);

    const first = await call(makeEnv(), `/avatar/${REFRESH}?d=identicon`);
    expect(first.headers.get("x-gravatar-cache")).toBe("MISS");

    const refreshed = await call(makeEnv(), `/avatar/${REFRESH}?d=identicon&refresh=1`);
    expect(refreshed.headers.get("x-gravatar-cache")).toBe("MISS");
    expect(refreshed.headers.get("cache-control")).toBe("no-store");
    expect(upstreamCalls).toBe(2);
  });
});

describe("bad upstream responses", () => {
  it("rejects an HTML error page", async () => {
    mockAvatar(HTML, {
      body: toArrayBuffer(new TextEncoder().encode("<!doctype html><html>no</html>")),
      contentType: "text/html",
    });

    const response = await call(makeEnv(), `/avatar/${HTML}`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_NOT_IMAGE");
  });

  it("rejects a payload that is too large", async () => {
    mockAvatar(LARGE);

    const response = await call(makeEnv({ MAX_AVATAR_BYTES: "8" }), `/avatar/${LARGE}`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_TOO_LARGE");
  });
});

describe("caller allow list", () => {
  it("allows a listed referer", async () => {
    mockAvatar(HOSTS);

    const response = await call(makeEnv({ HOSTS: "allowed.test" }), `/avatar/${HOSTS}`, {
      headers: { referer: "https://allowed.test/page" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a referer that is not on the list", async () => {
    const response = await call(makeEnv({ HOSTS: "allowed.test" }), `/avatar/${HOSTS}`, {
      headers: { referer: "https://evil.test/page" },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REFERER_NOT_ALLOWED");
  });

  it("rejects an empty referer unless ALLOW_EMPTY_REFERER is on", async () => {
    const blocked = await call(
      makeEnv({ HOSTS: "allowed.test", ALLOW_EMPTY_REFERER: "0" }),
      `/avatar/${HOSTS}`,
    );
    expect(blocked.status).toBe(403);

    const allowed = await call(
      makeEnv({ HOSTS: "allowed.test", ALLOW_EMPTY_REFERER: "1" }),
      `/avatar/${HOSTS}`,
    );
    expect(allowed.status).toBe(200);
  });

  it("matches subdomains and Origin", async () => {
    mockAvatar(HOSTS);

    const response = await call(makeEnv({ HOSTS: "allowed.test" }), `/avatar/${HOSTS}`, {
      headers: { origin: "https://blog.allowed.test" },
    });
    expect(response.status).toBe(200);
  });
});

describe("operational endpoints", () => {
  it("answers /health", async () => {
    const response = await call(makeEnv(), "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "gravatar-api" });
  });

  it("answers / with a usage hint", async () => {
    const response = await call(makeEnv(), "/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { service: string; usage: string };
    expect(body.service).toBe("gravatar-api");
    expect(body.usage).toContain("/avatar/");
  });
});

describe("Workers Cache loopback", () => {
  it("forwards the internal URL and cache key to the cached entrypoint", async () => {
    let seenUrl = "";
    let seenCacheKey: string | undefined;

    const fakeCtx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      exports: {
        Gravatar: {
          fetch: async (
            request: Request,
            init?: { cf?: { cacheKey?: string } },
          ): Promise<Response> => {
            seenUrl = request.url;
            seenCacheKey = init?.cf?.cacheKey;
            return new Response(PNG, {
              headers: { "content-type": "image/png", "x-gravatar-cache": "FRESH" },
            });
          },
        },
      },
    } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request(`https://worker.test/avatar/${MAIN}?s=80&r=G&d=identicon`),
      makeEnv({ WORKERS_CACHE: "1" }),
      fakeCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-gravatar-cache")).toBe("FRESH");

    const inner = new URL(seenUrl);
    expect(inner.origin).toBe("https://gravatar.internal");
    expect(inner.pathname).toBe("/v1/avatar");
    expect(inner.searchParams.get("h")).toBe(MAIN);
    expect(inner.searchParams.get("s")).toBe("80");
    expect(inner.searchParams.get("d")).toBe("identicon");
    expect(inner.searchParams.get("r")).toBe("g");
    expect(inner.searchParams.get("f")).toBe("0");
    expect(inner.searchParams.get("x")).toBe("0");
    expect(seenCacheKey).toBe(inner.pathname + inner.search);
  });
});
