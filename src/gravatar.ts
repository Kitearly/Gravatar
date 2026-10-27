/**
 * The cached layer.
 *
 * Workers Cache sits in front of this entrypoint: on a hit the Worker does not
 * run at all, not even the KV read. Only a miss reaches the logic below.
 *
 * This entrypoint does not know who the caller is — the allow list is checked
 * in the gateway (`src/index.ts`), which is never cached.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { loadConfig, type Config } from "./config";
import {
  kvKeyFail,
  kvKeyLast,
  kvKeyNow,
  randomNowTtlSeconds,
  readAvatar,
  readFail,
  writeAvatar,
  writeFail,
  type StoredAvatar,
} from "./kv";
import { avatarKey, parseInternalParams, type AvatarParams } from "./params";
import { CORS_HEADERS, describe, errorResponse } from "./respond";
import type { AvatarMeta, CacheState, Env } from "./types";
import { fetchAvatar, UpstreamError } from "./upstream";

/**
 * Negative cache lifetime (seconds) for 404 results.
 *
 * Only a definitive 404 is cached. A transient Gravatar outage must not lock
 * the variant out for half an hour after the service recovers.
 */
const FAIL_TTL_SECONDS = 1_800;

/**
 * Edge `max-age` range (seconds), picked at random for every response.
 *
 * It must be much shorter than the KV lifetime: the edge copy expires first
 * and then revalidates against KV, which is cheap. Randomizing it keeps the
 * revalidation grid from collapsing onto a single moment.
 */
const EDGE_MIN = 600;
const EDGE_MAX = 3_600;

/** How long the edge may keep serving a copy when the origin errors. */
const STALE_IF_ERROR = 86_400;

export class Gravatar extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const { env, ctx } = this;
    const config = loadConfig(env);

    const params = parseInternalParams(new URL(request.url).searchParams);
    if (params === null) {
      return errorResponse(400, "INVALID_REQUEST", "The internal request is malformed.");
    }

    const key = avatarKey(params);
    const nowKey = kvKeyNow(key);
    const lastKey = kvKeyLast(key);
    const failKey = kvKeyFail(key);

    // 1) The current copy is still valid — the key's existence is the freshness.
    if (!params.refresh) {
      const fresh = await readAvatar(env, nowKey, config.edgeTtlSeconds);
      if (fresh !== null) {
        return imageResponse(fresh, "FRESH", params, request.method);
      }
    }

    // 2) Negative cache: this variant recently returned 404.
    if (!params.refresh) {
      const failure = await readFail(env, failKey);
      if (failure !== null) {
        return notFoundResponse(params, "NEGATIVE", failure);
      }
    }

    // 3) No current copy, but a last successful one: hand it out immediately
    //    and refresh in the background.
    if (!params.refresh) {
      const last = await readAvatar(env, lastKey, config.edgeTtlSeconds);
      if (last !== null) {
        ctx.waitUntil(
          refreshInBackground(env, nowKey, lastKey, failKey, params, config).catch(
            () => undefined,
          ),
        );
        return imageResponse(last, "STALE", params, request.method, "stale while revalidating");
      }
    }

    // 4) Nothing left, fetch from Gravatar.
    try {
      const fetched = await fetchAvatar(params, {
        timeoutMs: config.fetchTimeoutMs,
        maxBytes: config.maxAvatarBytes,
      });

      const meta: AvatarMeta = {
        ct: fetched.contentType,
        url: fetched.finalUrl,
        at: Date.now(),
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      };

      ctx.waitUntil(
        storeAvatar(env, nowKey, lastKey, fetched.bytes, meta).catch(() => undefined),
      );

      return imageResponse({ bytes: fetched.bytes, meta }, "MISS", params, request.method);
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) {
        await writeFail(env, failKey, "404", FAIL_TTL_SECONDS);
        return notFoundResponse(params, "MISS", "404");
      }

      const reason = describe(error);

      // A stale copy is better than an error, even for a forced refresh.
      const last = await readAvatar(env, lastKey, 60);
      if (last !== null) {
        return imageResponse(last, "STALE", params, request.method, reason);
      }

      if (error instanceof UpstreamError) {
        const extra = error.retryAfter ? { "retry-after": error.retryAfter } : undefined;
        return errorResponse(error.status, error.code, error.message, extra);
      }

      return errorResponse(502, "UPSTREAM_ERROR", reason);
    }
  }
}

/**
 * Refresh a stale copy in the background.
 *
 * A 404 updates the negative cache. Other failures are deliberately ignored:
 * the stale copy is still being served, and the next request will retry.
 */
async function refreshInBackground(
  env: Env,
  nowKey: string,
  lastKey: string,
  failKey: string,
  params: AvatarParams,
  config: Config,
): Promise<void> {
  try {
    const fetched = await fetchAvatar(params, {
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.maxAvatarBytes,
    });

    const meta: AvatarMeta = {
      ct: fetched.contentType,
      url: fetched.finalUrl,
      at: Date.now(),
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    };

    await storeAvatar(env, nowKey, lastKey, fetched.bytes, meta);
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) {
      await writeFail(env, failKey, "404", FAIL_TTL_SECONDS);
    }
  }
}

/** Store an avatar under both keys. The permanent copy is written first. */
async function storeAvatar(
  env: Env,
  nowKey: string,
  lastKey: string,
  bytes: Uint8Array,
  meta: AvatarMeta,
): Promise<void> {
  await writeAvatar(env, lastKey, bytes, meta, null);
  await writeAvatar(env, nowKey, bytes, meta, randomNowTtlSeconds());
}

/** Build the response that carries the avatar. */
function imageResponse(
  avatar: StoredAvatar,
  state: CacheState,
  params: AvatarParams,
  method: string,
  reason?: string,
): Response {
  const headers = new Headers({
    "content-type": avatar.meta.ct,
    "cache-control": params.refresh
      ? "no-store"
      : `public, max-age=${edgeMaxAge()}, stale-if-error=${STALE_IF_ERROR}`,
    "cache-tag": `gravatar, gravatar:${params.hash}`,
    "x-gravatar-cache": state,
    "x-gravatar-final-url": avatar.meta.url,
    "x-content-type-options": "nosniff",
    ...CORS_HEADERS,
  });

  if (avatar.meta.etag) headers.set("etag", avatar.meta.etag);
  if (avatar.meta.lastModified) headers.set("last-modified", avatar.meta.lastModified);
  if (reason) headers.set("x-gravatar-reason", reason.slice(0, 200));

  return new Response(method === "HEAD" ? null : avatar.bytes, { headers });
}

/** Build the response for a variant Gravatar says does not exist. */
function notFoundResponse(
  params: AvatarParams,
  state: CacheState,
  reason?: string,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-gravatar-cache": state,
    "x-content-type-options": "nosniff",
    ...CORS_HEADERS,
  });
  if (reason) headers.set("x-gravatar-reason", reason.slice(0, 200));

  return new Response(
    JSON.stringify({
      error: { code: "NOT_FOUND", message: `No Gravatar for ${params.hash}.` },
    }),
    { status: 404, headers },
  );
}

/** Edge cache lifetime: picked at random so the revalidation grid drifts. */
function edgeMaxAge(): number {
  return EDGE_MIN + Math.floor(Math.random() * (EDGE_MAX - EDGE_MIN));
}
