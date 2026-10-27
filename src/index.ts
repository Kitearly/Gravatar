/**
 * Gateway.
 *
 * This layer is **not cached** (see `exports.default.cache` in
 * `wrangler.jsonc`), so it runs on every request.
 *
 * Workers Cache keys do not include `Referer` / `Origin`, so the caller allow
 * list must live here: putting it in the cached layer would let unauthorized
 * callers read cached avatars, and a legitimate 403 could be cached and served
 * to everybody.
 *
 * After validation the request is handed to the cached `Gravatar` entrypoint
 * (see `src/gravatar.ts`). The internal URL encodes the hash, size and options
 * in its path and query string — that *is* the Workers Cache key.
 */

import { isAllowedCaller } from "./caller";
import { loadConfig } from "./config";
import { Gravatar } from "./gravatar";
import {
  buildInternalUrl,
  ParamError,
  parseAvatarPath,
  parsePublicParams,
  type AvatarParams,
} from "./params";
import { CORS_HEADERS, describe, errorResponse } from "./respond";
import type { Env } from "./types";

export { Gravatar };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "Only GET, HEAD and OPTIONS are supported.",
        { allow: "GET, HEAD, OPTIONS" },
      );
    }

    const requestUrl = new URL(request.url);

    // Operational endpoints are public and never cached by this Worker.
    if (requestUrl.pathname === "/health") {
      return stripBodyForHead(
        request,
        jsonResponse({ ok: true, service: "gravatar-api" }),
      );
    }
    if (requestUrl.pathname === "/") {
      return stripBodyForHead(
        request,
        jsonResponse({
          service: "gravatar-api",
          usage: "/avatar/<md5-or-sha256-hash>?s=80&r=G&d=identicon",
        }),
      );
    }

    if (!isAllowedCaller(request, config.hosts, config.allowEmptyReferer)) {
      return stripBodyForHead(
        request,
        errorResponse(
          403,
          "REFERER_NOT_ALLOWED",
          "This service is restricted to the configured hosts.",
        ),
      );
    }

    const hash = parseAvatarPath(requestUrl.pathname);
    if (hash === null) {
      return stripBodyForHead(
        request,
        errorResponse(
          400,
          "INVALID_HASH",
          "Path must be /avatar/<32 (MD5) or 64 (SHA-256) hexadecimal hash>.",
        ),
      );
    }

    let params: AvatarParams;
    try {
      params = parsePublicParams(hash, requestUrl.searchParams);
    } catch (error) {
      if (error instanceof ParamError) {
        return stripBodyForHead(request, errorResponse(400, error.code, error.message));
      }
      return stripBodyForHead(
        request,
        errorResponse(400, "INVALID_REQUEST", describe(error)),
      );
    }

    const inner = buildInternalUrl(params);

    // The internal request carries none of the caller's headers and is always
    // a GET:
    // - an Authorization header would make Workers Cache bypass the entry;
    // - x-forwarded-* / x-http-method-override would fragment the cache key;
    // - a HEAD request on a cold cache still stores the full body, so the next
    //   GET can hit it directly.
    const internalRequest = new Request(inner.toString(), { method: "GET" });

    // With WORKERS_CACHE=1 the gateway goes through the `ctx.exports` loopback
    // so Workers Cache can take over the inner entrypoint. `cf.cacheKey` is
    // the same path + query string as the internal URL. Otherwise (local tests
    // without an injectable env, or accounts where the edge layer does not
    // engage) fall back to an in-process call: same logic, same response, just
    // without the edge cache.
    if (config.workersCache) {
      const binding = ctx.exports?.Gravatar;
      if (binding) {
        const response = await binding.fetch(internalRequest, {
          cf: { cacheKey: inner.pathname + inner.search },
        });
        return stripBodyForHead(request, response);
      }
    }

    return stripBodyForHead(request, await new Gravatar(ctx, env).fetch(internalRequest));
  },
};

/** Build a small JSON response for the operational endpoints. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}

/** HEAD only needs the headers; the internal request fetched a full GET. */
function stripBodyForHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, { status: response.status, headers: response.headers });
}
