/**
 * Request parameters.
 *
 * The gateway and the cached entrypoint share this definition: the gateway
 * encodes the parameters into the internal URL and the inner layer reads them
 * back, so both always see the same canonical values.
 */

/** Default avatar size. */
export const DEFAULT_SIZE = 80;

/** Smallest accepted avatar size. */
export const MIN_SIZE = 1;

/** Largest accepted avatar size. */
export const MAX_SIZE = 2_048;

/** Ratings understood by Gravatar. */
export type Rating = "g" | "pg" | "r" | "x";

/** Built-in default images understood by Gravatar. */
export const DEFAULT_IMAGES = [
  "404",
  "mp",
  "identicon",
  "monsterid",
  "wavatar",
  "retro",
  "robohash",
  "blank",
  "initials",
  "color",
] as const;

/** A validated and canonical set of avatar parameters. */
export interface AvatarParams {
  /** Lower-case MD5 or SHA-256 hash. */
  hash: string;
  /** Requested size in pixels, already clamped to the accepted range. */
  size: number;
  /** Built-in default image, or "" for Gravatar's own default. */
  default: string;
  /** Maximum rating. */
  rating: Rating;
  /** Whether Gravatar must always return the default image. */
  force: boolean;
  /** Whether the cache must be bypassed. */
  refresh: boolean;
}

/** Thrown when a request parameter is unusable. */
export class ParamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ParamError";
  }
}

const HASH_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/i;

/** Whether a value looks like a Gravatar MD5 or SHA-256 hash. */
export function isValidHash(raw: string): boolean {
  return HASH_PATTERN.test(raw);
}

/**
 * Extract the hash from `/avatar/<hash>`.
 *
 * A trailing `.jpg` / `.png` / ... is accepted for compatibility with clients
 * that insist on a file extension; the actual content type comes from the
 * image itself.
 */
export function parseAvatarPath(pathname: string): string | null {
  const match =
    /^\/avatar\/([0-9a-f]{32}|[0-9a-f]{64})(?:\.(?:jpe?g|png|gif|webp|avif))?\/?$/i.exec(
      pathname,
    );
  return match?.[1]?.toLowerCase() ?? null;
}

/** Parse a size, clamping it into the accepted range. */
export function parseSize(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_SIZE;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, parsed));
}

function normalizeDefault(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";

  const value = raw.trim().toLowerCase();
  if (value === "") return "";
  if (!(DEFAULT_IMAGES as readonly string[]).includes(value)) {
    throw new ParamError("INVALID_DEFAULT", `Unsupported default image "${raw}".`);
  }
  return value;
}

function normalizeRating(raw: string | null | undefined): Rating {
  if (raw === null || raw === undefined || raw.trim() === "") return "g";

  const value = raw.trim().toLowerCase();
  if (value !== "g" && value !== "pg" && value !== "r" && value !== "x") {
    throw new ParamError("INVALID_RATING", `Unsupported rating "${raw}".`);
  }
  return value;
}

function normalizeFlag(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;

  const value = raw.trim().toLowerCase();
  return value === "y" || value === "yes" || value === "1" || value === "true";
}

/** Raw values as they appear in the public or internal URL. */
export interface RawParams {
  hash: string;
  size?: string | null;
  default?: string | null;
  rating?: string | null;
  force?: string | null;
  refresh?: string | null;
}

/** Validate and canonicalize a set of raw parameters. */
export function normalizeParams(raw: RawParams): AvatarParams {
  const hash = raw.hash.toLowerCase();
  if (!isValidHash(hash)) {
    throw new ParamError(
      "INVALID_HASH",
      "Hash must be 32 (MD5) or 64 (SHA-256) hexadecimal characters.",
    );
  }

  return {
    hash,
    size: parseSize(raw.size),
    default: normalizeDefault(raw.default),
    rating: normalizeRating(raw.rating),
    force: normalizeFlag(raw.force),
    refresh: normalizeFlag(raw.refresh),
  };
}

/** Read the public query parameters. */
export function parsePublicParams(hash: string, search: URLSearchParams): AvatarParams {
  return normalizeParams({
    hash,
    size: search.get("s") ?? search.get("size"),
    default: search.get("d") ?? search.get("default"),
    rating: search.get("r") ?? search.get("rating"),
    force: search.get("f") ?? search.get("force"),
    refresh: search.get("refresh"),
  });
}

/** Read the parameters of the internal URL built by the gateway. */
export function parseInternalParams(search: URLSearchParams): AvatarParams | null {
  const hash = search.get("h");
  if (hash === null) return null;

  const defaultRaw = search.get("d");
  try {
    return normalizeParams({
      hash,
      size: search.get("s"),
      default: defaultRaw === "-" ? null : defaultRaw,
      rating: search.get("r"),
      force: search.get("f"),
      refresh: search.get("x"),
    });
  } catch {
    return null;
  }
}

/**
 * The canonical key shared by `av:now`, `av:last` and `fail:`.
 *
 * Every value that changes the image is part of the key. Values that do not
 * change the image (e.g. `refresh`) are deliberately absent.
 */
export function avatarKey(params: AvatarParams): string {
  const defaultToken = params.default === "" ? "-" : params.default;
  return `${params.hash}:${params.size}:${defaultToken}:${params.rating}:${
    params.force ? "1" : "0"
  }`;
}

/**
 * Build the internal URL.
 *
 * Its path and query string *are* the Workers Cache key. The gateway hands
 * the same string to `cf.cacheKey`, so both sides always agree even if the
 * `cf` object is dropped for any reason.
 */
export function buildInternalUrl(params: AvatarParams): URL {
  const url = new URL("https://gravatar.internal/v1/avatar");
  url.searchParams.set("h", params.hash);
  url.searchParams.set("s", String(params.size));
  url.searchParams.set("d", params.default === "" ? "-" : params.default);
  url.searchParams.set("r", params.rating);
  url.searchParams.set("f", params.force ? "1" : "0");
  url.searchParams.set("x", params.refresh ? "1" : "0");
  return url;
}
