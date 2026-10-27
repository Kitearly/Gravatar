#!/usr/bin/env node
/**
 * Garbage collect the Gravatar KV namespace.
 *
 * `av:now` expires on its own, but `av:last` never does, so the namespace
 * grows with every avatar variant that has ever been asked for. This script
 * lists the keys of a prefix and deletes the ones the Worker stamped as old
 * enough (the write time lives in the KV metadata as `at`).
 *
 *   npm run kv:gc -- --prefix av:last: --older-than 30d --delete
 *
 * Without `--delete` the script only reports what it would remove.
 *
 * Note: `wrangler kv key list` returns at most 1000 keys per call. When the
 * report says 1000 keys, run it again until it lists fewer.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Strip comments and trailing commas so that JSONC can be parsed as JSON. */
function parseJsonc(source) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function parseArgs(argv) {
  const options = {
    prefix: "av:last:",
    olderThanMs: 30 * 24 * 60 * 60 * 1000,
    namespaceId: process.env.GRAVATAR_KV_NAMESPACE_ID,
    delete: false,
    local: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--prefix":
        options.prefix = argv[++i] ?? options.prefix;
        break;
      case "--older-than": {
        const value = argv[++i] ?? "30d";
        const match = /^(\d+)\s*([smhdw])$/.exec(value);
        if (!match) {
          throw new Error(`Invalid --older-than value: ${value}`);
        }
        const amount = Number(match[1]);
        const unit = {
          s: 1e3,
          m: 60e3,
          h: 3600e3,
          d: 86400e3,
          w: 604800e3,
        }[match[2]];
        options.olderThanMs = amount * unit;
        break;
      }
      case "--namespace-id":
        options.namespaceId = argv[++i] ?? options.namespaceId;
        break;
      case "--delete":
        options.delete = true;
        break;
      case "--local":
        options.local = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function namespaceIdFromConfig() {
  try {
    const config = parseJsonc(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"));
    const namespaces = config.kv_namespaces ?? [];
    const entry = namespaces.find((item) => item.binding === "GRAVATAR_KV") ?? namespaces[0];
    return entry?.id;
  } catch {
    return undefined;
  }
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", cwd: ROOT });
}

function listKeys(namespaceId, prefix, local) {
  const args = ["kv", "key", "list", "--namespace-id", namespaceId, "--prefix", prefix];
  if (local) {
    args.push("--local", "--persist-to", resolve(ROOT, ".wrangler/state"));
  }

  const output = wrangler(args);
  const trimmed = output.trim();
  if (trimmed === "") return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Older wrangler versions emit one JSON object per line.
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

const options = parseArgs(process.argv.slice(2));
const namespaceId = options.namespaceId ?? namespaceIdFromConfig();

if (!namespaceId) {
  console.error(
    "No namespace id. Pass --namespace-id <id> or set GRAVATAR_KV_NAMESPACE_ID.",
  );
  process.exit(1);
}

const keys = listKeys(namespaceId, options.prefix, options.local);
const cutoff = Date.now() - options.olderThanMs;

// The creation time is stored in the KV metadata by the Worker.
const expired = keys.filter((key) => {
  const at = Number(key.metadata?.at ?? NaN);
  return Number.isFinite(at) && at < cutoff;
});

console.log(`${keys.length} key(s) with prefix "${options.prefix}"`);
console.log(`${expired.length} of them are older than the cutoff`);

for (const key of expired) {
  console.log(`  ${key.name}`);
}

if (!options.delete) {
  console.log("\nDry run. Add --delete to actually remove them.");
  process.exit(0);
}

for (const key of expired) {
  const args = ["kv", "key", "delete", key.name, "--namespace-id", namespaceId];
  if (options.local) {
    args.push("--local", "--persist-to", resolve(ROOT, ".wrangler/state"));
  }
  wrangler(args);
  console.log(`deleted ${key.name}`);
}
