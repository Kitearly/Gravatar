/**
 * Fetching an avatar from Gravatar.
 *
 * The origin is fixed, so there is no user-controlled target to validate.
 * The response is still read with a size cap and its type is derived from the
 * magic bytes, never from the upstream header alone.
 */

import type { AvatarParams } from "./params";
import { describe } from "./respond";
import { sniffRasterImageType } from "./sniff";

/** The only origin this Worker talks to. */
export const GRAVATAR_ORIGIN = "https://gravatar.com";

/** Options for {@link fetchAvatar}. */
export interface UpstreamOptions {
  /** Maximum duration of the request, in milliseconds. */
  timeoutMs: number;
  /** Maximum size of the response body, in bytes. */
  maxBytes: number;
}

/** An avatar that was fetched successfully. */
export interface FetchedAvatar {
  /** Raw image bytes. */
  bytes: Uint8Array;
  /** Sniffed content type. */
  contentType: string;
  /** URL the bytes were finally loaded from. */
  finalUrl: string;
  /** ETag reported by Gravatar, if any. */
  etag?: string;
  /** Last-Modified reported by Gravatar, if any. */
  lastModified?: string;
}

/** A failure that maps onto an HTTP response. */
export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Build the canonical Gravatar URL for a set of parameters. */
export function buildUpstreamUrl(params: AvatarParams): URL {
  const url = new URL(`/avatar/${params.hash}`, GRAVATAR_ORIGIN);
  url.searchParams.set("s", String(params.size));
  if (params.default !== "") url.searchParams.set("d", params.default);
  url.searchParams.set("r", params.rating);
  if (params.force) url.searchParams.set("f", "y");
  return url;
}

/** Read a body, stopping after `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = response.headers.get("content-length");
  const length = declared === null ? Number.NaN : Number(declared);

  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: new Uint8Array(0), truncated: true };
  }

  if (!response.body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    chunks.push(value);

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), truncated: true };
    }
  }

  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, truncated: false };
}

/** Fetch an avatar from Gravatar. */
export async function fetchAvatar(
  params: AvatarParams,
  options: UpstreamOptions,
): Promise<FetchedAvatar> {
  const target = buildUpstreamUrl(params);

  let response: Response;
  try {
    response = await fetch(target.toString(), {
      method: "GET",
      headers: {
        accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new UpstreamError(504, "UPSTREAM_TIMEOUT", "Gravatar did not answer in time.");
    }
    throw new UpstreamError(
      502,
      "UPSTREAM_ERROR",
      `Could not reach Gravatar: ${describe(error)}`,
    );
  }

  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(404, "NOT_FOUND", "No avatar for this hash.");
  }

  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(
      503,
      "UPSTREAM_RATE_LIMITED",
      "Gravatar rate limited the request.",
      response.headers.get("retry-after") ?? "60",
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(502, "UPSTREAM_ERROR", `Gravatar answered ${response.status}.`);
  }

  const { bytes, truncated } = await readCapped(response, options.maxBytes);
  if (truncated) {
    throw new UpstreamError(
      502,
      "UPSTREAM_TOO_LARGE",
      "Gravatar returned a payload that is too large.",
    );
  }

  const contentType = sniffRasterImageType(bytes);
  if (contentType === null) {
    throw new UpstreamError(
      502,
      "UPSTREAM_NOT_IMAGE",
      "Gravatar returned something that is not a supported image.",
    );
  }

  return {
    bytes,
    contentType,
    finalUrl: response.url || target.toString(),
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
}
