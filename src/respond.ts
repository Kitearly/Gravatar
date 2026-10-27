/**
 * Response helpers shared by both entrypoints.
 */

/** CORS headers shared by the gateway and the cached entrypoint. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match, if-modified-since",
  "access-control-max-age": "86400",
  "access-control-expose-headers":
    "etag, last-modified, x-gravatar-cache, x-gravatar-final-url, x-gravatar-reason, cf-cache-status",
};

/** Build a JSON error response. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Workers Cache applies heuristic freshness to responses without a
      // Cache-Control header. Errors must never be cached.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

/** Turn an unknown thrown value into a readable message. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
