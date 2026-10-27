#!/usr/bin/env node
/**
 * Compute the Gravatar hash of an email address.
 *
 * Gravatar's rules: trim leading and trailing whitespace, lower-case the whole
 * address, then hash it. SHA-256 is the current recommendation; MD5 is still
 * accepted by the avatar endpoint and is printed too for compatibility.
 *
 *   npm run hash -- MyEmail@example.com
 */

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"));

if (!email) {
  console.error("Usage: npm run hash -- <email>");
  process.exit(1);
}

const normalized = email.trim().toLowerCase();
const sha256 = createHash("sha256").update(normalized).digest("hex");
const md5 = createHash("md5").update(normalized).digest("hex");

console.log(`email:   ${normalized}`);
console.log(`sha256:  ${sha256}`);
console.log(`md5:     ${md5}`);
