import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256Bytes } from "../hash.mjs";
import { stableJson } from "../json.mjs";
import { canonicalJson } from "../normalization/inputs.mjs";

export const BATCH_CACHE_SCHEMA_VERSION = "openinspect-trace-batch-cache-e0-v0";

export function batchCacheKey(cacheIdentity) {
  return sha256Bytes(
    Buffer.from(canonicalJson({ schemaVersion: BATCH_CACHE_SCHEMA_VERSION, ...cacheIdentity }))
  );
}

function cacheEntryPath(cacheRoot, cacheKey) {
  return resolve(cacheRoot, cacheKey.slice(0, 2), cacheKey, "cache-entry.json");
}

export function readBatchCache(cacheRoot, cacheKey, expectedIdentity) {
  const path = cacheEntryPath(cacheRoot, cacheKey);
  if (!existsSync(path)) return null;
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid batch cache entry ${cacheKey}: ${error instanceof Error ? error.message : error}`
    );
  }
  if (
    entry.schemaVersion !== BATCH_CACHE_SCHEMA_VERSION ||
    entry.cacheKey !== cacheKey ||
    canonicalJson(entry.cacheIdentity) !== canonicalJson(expectedIdentity) ||
    !entry.run
  ) {
    throw new Error(`Batch cache identity mismatch: ${cacheKey}`);
  }
  return entry.run;
}

export function writeBatchCache(cacheRoot, cacheKey, cacheIdentity, run) {
  const path = cacheEntryPath(cacheRoot, cacheKey);
  if (existsSync(path)) return;
  const directory = dirname(path);
  const partial = `${directory}.partial-${process.pid}`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      resolve(partial, "cache-entry.json"),
      stableJson({
        schemaVersion: BATCH_CACHE_SCHEMA_VERSION,
        cacheKey,
        cacheIdentity,
        run,
      }),
      { mode: 0o600 }
    );
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    renameSync(partial, directory);
  } catch (error) {
    if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
    if (!existsSync(path)) throw error;
  }
}
