/**
 * Bindings and environment variables of the Worker.
 */
export interface Env {
  /** KV namespace holding the cached avatars. */
  GRAVATAR_KV: KVNamespace;
  /** Referer hosts that may use the API. Empty means "no restriction". */
  HOSTS?: string;
  /** Set to "1" to allow requests without a `Referer` header. */
  ALLOW_EMPTY_REFERER?: string;
  /** Edge cache TTL applied to KV reads, in seconds. */
  KV_EDGE_TTL_SECONDS?: string;
  /** Maximum size of an avatar payload, in bytes. */
  MAX_AVATAR_BYTES?: string;
  /** Total budget for one upstream request, in milliseconds. */
  FETCH_TIMEOUT_MS?: string;
  /**
   * Set to "1" to route the gateway through the `ctx.exports` loopback so that
   * Workers Cache can cache the inner entrypoint's responses.
   */
  WORKERS_CACHE?: string;
}

/**
 * Everything about a stored avatar that is not the avatar itself.
 *
 * It is kept in the KV metadata so that the value can stay raw image bytes.
 */
export interface AvatarMeta {
  /** Sniffed content type of the payload. */
  ct: string;
  /** Absolute URL the payload was fetched from. */
  url: string;
  /**
   * Write time (ms since epoch), stamped by the Worker.
   *
   * `av:last` never expires, so it cannot be garbage collected by TTL and the
   * cleanup script needs this to tell old entries from new ones.
   */
  at: number;
  /** ETag reported by Gravatar, passed through to the client. */
  etag?: string;
  /** Last-Modified reported by Gravatar, passed through to the client. */
  lastModified?: string;
}

/** How the served image relates to the store. */
export type CacheState = "FRESH" | "STALE" | "MISS" | "NEGATIVE";
