import type { Env } from "./types";

/** Runtime configuration, derived from the environment variables. */
export interface Config {
  /** Referer hosts that may use the API. Empty means "no restriction". */
  hosts: string[];
  /** Whether requests without a referer are accepted. */
  allowEmptyReferer: boolean;
  /** Edge cache TTL applied to KV reads, in seconds. */
  edgeTtlSeconds: number;
  /** Maximum avatar payload size, in bytes. */
  maxAvatarBytes: number;
  /** Total budget for one upstream request, in milliseconds. */
  fetchTimeoutMs: number;
  /** Whether the gateway forwards through the Workers Cache loopback. */
  workersCache: boolean;
}

const DEFAULTS = {
  edgeTtlSeconds: 3_600,
  maxAvatarBytes: 5 * 1_024 * 1_024,
  fetchTimeoutMs: 8_000,
} as const;

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function integer(value: string | undefined, fallback: number, minimum = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function parseHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

/** Read the configuration out of the environment. */
export function loadConfig(env: Env): Config {
  return {
    hosts: parseHosts(env.HOSTS),
    allowEmptyReferer: flag(env.ALLOW_EMPTY_REFERER),
    edgeTtlSeconds: integer(env.KV_EDGE_TTL_SECONDS, DEFAULTS.edgeTtlSeconds, 60),
    maxAvatarBytes: integer(env.MAX_AVATAR_BYTES, DEFAULTS.maxAvatarBytes, 1),
    fetchTimeoutMs: integer(env.FETCH_TIMEOUT_MS, DEFAULTS.fetchTimeoutMs, 1),
    workersCache: flag(env.WORKERS_CACHE),
  };
}
