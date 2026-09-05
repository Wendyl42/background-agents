import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REQUIRED_BUNDLE_PATHS,
  REQUIRED_HASHED_EVIDENCE_PATHS,
  SUPPORTED_BUNDLE_SCHEMA_VERSIONS,
} from "./constants.mjs";
import { TraceBundleError } from "./errors.mjs";
import { fingerprintBundle, hashFile } from "./hash.mjs";
import { readJson, readJsonl, readText } from "./json.mjs";

function resolveBundlePath(bundleDir, candidate) {
  if (typeof candidate !== "string" || candidate === "" || isAbsolute(candidate)) {
    throw new TraceBundleError(`Invalid bundle-relative path: ${String(candidate)}`);
  }
  const target = resolve(bundleDir, candidate);
  const rel = relative(bundleDir, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new TraceBundleError(`Bundle path escapes root: ${candidate}`);
  }
  return target;
}

function assertRootDirectory(bundleDir) {
  if (!existsSync(bundleDir))
    throw new TraceBundleError(`Trace bundle does not exist: ${bundleDir}`);
  const metadata = lstatSync(bundleDir);
  if (metadata.isSymbolicLink()) {
    throw new TraceBundleError("Trace bundle root must not be a symlink");
  }
  if (!metadata.isDirectory()) {
    throw new TraceBundleError("Trace bundle root must be a directory");
  }
  return realpathSync(bundleDir);
}

function assertRegularFileInsideBundle(bundleDir, bundleRealRoot, candidate) {
  const target = resolveBundlePath(bundleDir, candidate);
  const segments = candidate.split(/[\\/]/).filter(Boolean);
  let current = bundleDir;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) throw new TraceBundleError(`Bundle file is missing: ${candidate}`);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new TraceBundleError(`Bundle path must not contain symlinks: ${candidate}`);
    }
  }

  const metadata = lstatSync(target);
  if (!metadata.isFile()) {
    throw new TraceBundleError(`Bundle evidence must be a regular file: ${candidate}`);
  }
  const realTarget = realpathSync(target);
  const realRelative = relative(bundleRealRoot, realTarget);
  if (
    realRelative === "" ||
    realRelative.startsWith(`..${sep}`) ||
    realRelative === ".." ||
    isAbsolute(realRelative)
  ) {
    throw new TraceBundleError(`Bundle file resolves outside real root: ${candidate}`);
  }
  return target;
}

function requireFiles(bundleDir, bundleRealRoot) {
  for (const path of REQUIRED_BUNDLE_PATHS) {
    assertRegularFileInsideBundle(bundleDir, bundleRealRoot, path);
  }
}

function requireHashCoverage(hashes) {
  const counts = new Map();
  for (const entry of hashes.files) {
    counts.set(entry?.path, (counts.get(entry?.path) ?? 0) + 1);
  }
  for (const path of REQUIRED_HASHED_EVIDENCE_PATHS) {
    const count = counts.get(path) ?? 0;
    if (count !== 1) {
      throw new TraceBundleError(
        `Required hashed evidence must appear exactly once in hashes.json: ${path} (found ${count})`
      );
    }
  }
}

function verifyHashEntries(bundleDir, bundleRealRoot, hashes) {
  if (hashes?.algorithm !== "sha256" || !Array.isArray(hashes.files)) {
    throw new TraceBundleError("hashes.json must contain a sha256 files array");
  }

  requireHashCoverage(hashes);

  const seen = new Set();
  const verified = [];
  for (const entry of hashes.files) {
    if (
      typeof entry?.path !== "string" ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new TraceBundleError("Invalid hashes.json entry", { entry });
    }
    if (seen.has(entry.path)) {
      throw new TraceBundleError(`Duplicate hashes.json path: ${entry.path}`);
    }
    seen.add(entry.path);

    const path = assertRegularFileInsideBundle(bundleDir, bundleRealRoot, entry.path);
    const actual = hashFile(path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new TraceBundleError(`Hash verification failed: ${entry.path}`, {
        expected: { bytes: entry.bytes, sha256: entry.sha256 },
        actual,
      });
    }
    verified.push({ path: entry.path, ...actual });
  }
  return verified.sort((left, right) => left.path.localeCompare(right.path));
}

export function loadTraceBundle(inputPath) {
  const bundleDir = resolve(inputPath);
  const bundleRealRoot = assertRootDirectory(bundleDir);
  requireFiles(bundleDir, bundleRealRoot);

  const manifestPath = join(bundleDir, "manifest.json");
  const hashesPath = join(bundleDir, "hashes.json");
  const manifestText = readText(manifestPath);
  const hashesText = readText(hashesPath);
  const manifest = readJson(manifestPath);
  const hashes = readJson(hashesPath);

  if (!SUPPORTED_BUNDLE_SCHEMA_VERSIONS.has(manifest?.schemaVersion)) {
    throw new TraceBundleError(
      `Unsupported trace bundle schema: ${String(manifest?.schemaVersion)}`
    );
  }

  const verifiedFiles = verifyHashEntries(bundleDir, bundleRealRoot, hashes);
  const sessionIndex = readJson(join(bundleDir, "raw/session-index.json"));

  return {
    bundleDir,
    inputFingerprint: fingerprintBundle(manifestText, hashesText),
    manifest,
    hashes,
    verifiedFiles,
    completeness: readJson(join(bundleDir, "completeness.json")),
    missingness: readJson(join(bundleDir, "missingness.json")),
    sessionIndex,
    sessions: sessionIndex?.sessions,
    events: readJsonl(join(bundleDir, "normalized/events.jsonl")),
    messages: readJsonl(join(bundleDir, "normalized/messages.jsonl")),
  };
}

export function isPathInside(parentPath, candidatePath) {
  const rel = relative(resolve(parentPath), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
