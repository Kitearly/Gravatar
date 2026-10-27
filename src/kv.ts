/**
 * KV persistence layer.
 *
 * Two keys per avatar variant:
 *
 *   av:now:<key>   the current copy, expires after a random 3 to 7 days
 *   av:last:<key>  the last successfully fetched copy, never expires
 *
 * Plus a negative cache for avatars that Gravatar says do not exist:
 *
 *   fail:<key>     the variant returned 404, do not retry for 30 minutes
 *
 * The value is the raw image bytes; everything else lives in the KV metadata.
 */

import type { AvatarMeta, Env } from "./types";

/** Key of the current copy. */
export const KEY_NOW = "av:now:";

/** Key of the last successfully fetched copy. */
export const KEY_LAST = "av:last:";

/** Key of the negative cache. */
export const KEY_FAIL = "fail:";

/** Shortest lifetime of `av:now`, in seconds (3 days). */
const NOW_TTL_MIN = 3 * 24 * 3_600;

/** Longest lifetime of `av:now`, in seconds (7 days). */
const NOW_TTL_MAX = 7 * 24 * 3_600;

/** Build the key of the current copy. */
export function kvKeyNow(key: string): string {
  return `${KEY_NOW}${key}`;
}

/** Build the key of the last successfully fetched copy. */
export function kvKeyLast(key: string): string {
  return `${KEY_LAST}${key}`;
}

/** Build the key of the negative cache. */
export function kvKeyFail(key: string): string {
  return `${KEY_FAIL}${key}`;
}

/**
 * A random lifetime for `av:now`, between 3 and 7 days.
 *
 * The randomness spreads the moments at which avatars are fetched again, so a
 * whole batch of entries never expires at the same time.
 */
export function randomNowTtlSeconds(): number {
  return NOW_TTL_MIN + Math.floor(Math.random() * (NOW_TTL_MAX - NOW_TTL_MIN + 1));
}

/** An avatar as it comes out of the store. */
export interface StoredAvatar {
  /** Raw image bytes. */
  bytes: Uint8Array;
  /** Everything that is known about the avatar besides its bytes. */
  meta: AvatarMeta;
}

/** Validate the metadata of a stored avatar. */
function parseMeta(raw: unknown): AvatarMeta | null {
  if (!raw || typeof raw !== "object") return null;

  const meta = raw as Partial<AvatarMeta>;
  if (typeof meta.ct !== "string" || !meta.ct.startsWith("image/")) return null;
  if (typeof meta.url !== "string" || meta.url === "") return null;
  if (typeof meta.at !== "number" || !Number.isFinite(meta.at)) return null;

  const etag = typeof meta.etag === "string" ? meta.etag : undefined;
  const lastModified = typeof meta.lastModified === "string" ? meta.lastModified : undefined;

  return { ct: meta.ct, url: meta.url, at: meta.at, etag, lastModified };
}

/**
 * Read an avatar.
 *
 * The value has to be read as an `arrayBuffer`: reading it as text would
 * replace every byte that is not valid UTF-8 and destroy the image.
 */
export async function readAvatar(
  env: Env,
  key: string,
  edgeTtlSeconds: number,
): Promise<StoredAvatar | null> {
  let result: { value: ArrayBuffer | null; metadata: unknown };
  try {
    result = await env.GRAVATAR_KV.getWithMetadata(key, {
      type: "arrayBuffer",
      cacheTtl: edgeTtlSeconds,
    });
  } catch {
    return null;
  }

  if (!result.value) return null;

  const meta = parseMeta(result.metadata);
  if (meta === null) return null;

  return { bytes: new Uint8Array(result.value), meta };
}

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.includes("Too Many Requests");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write an avatar.
 *
 * @param ttlSeconds lifetime of the entry, or null for "never expires"
 *
 * KV allows a single write per key per second, so a rate limited write is
 * retried with a short backoff. Failing to persist is never fatal for the
 * request that triggered the write.
 */
export async function writeAvatar(
  env: Env,
  key: string,
  bytes: Uint8Array,
  meta: AvatarMeta,
  ttlSeconds: number | null,
): Promise<boolean> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  const options =
    ttlSeconds === null
      ? { metadata: meta }
      : { metadata: meta, expirationTtl: Math.max(60, Math.floor(ttlSeconds)) };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await env.GRAVATAR_KV.put(key, buffer, options);
      return true;
    } catch (error) {
      if (!isRateLimited(error) || attempt === 2) return false;
      await delay(200 * 2 ** attempt);
    }
  }

  return false;
}

/**
 * Read the negative cache. Its presence means the avatar returned 404
 * recently and must not be requested again yet.
 */
export async function readFail(env: Env, key: string): Promise<string | null> {
  try {
    return await env.GRAVATAR_KV.get(key, { type: "text" });
  } catch {
    return null;
  }
}

/** Write the negative cache. The value is the reason of the failure. */
export async function writeFail(
  env: Env,
  key: string,
  reason: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    await env.GRAVATAR_KV.put(key, reason.slice(0, 200), {
      expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
    });
    return true;
  } catch {
    return false;
  }
}
