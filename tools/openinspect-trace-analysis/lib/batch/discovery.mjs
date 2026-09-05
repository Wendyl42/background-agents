import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { sha256Bytes } from "../hash.mjs";

const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules", "analysis"]);

function isExcluded(path, excludedRoots) {
  return excludedRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

function trustAnchorFingerprint(path) {
  try {
    const manifest = readFileSync(resolve(path, "manifest.json"));
    const hashes = readFileSync(resolve(path, "hashes.json"));
    return sha256Bytes(
      Buffer.concat([
        Buffer.from("manifest.json\0"),
        manifest,
        Buffer.from("hashes.json\0"),
        hashes,
      ])
    );
  } catch (error) {
    return sha256Bytes(
      Buffer.from(
        `unreadable-trust-anchors\0${error instanceof Error ? (error.code ?? error.message) : error}`
      )
    );
  }
}

export function discoverTraceBundles(rootPath, { excludedRoots = [] } = {}) {
  const root = realpathSync(resolve(rootPath));
  const excluded = excludedRoots.map((path) => resolve(path)).sort();
  const candidates = [];
  const visited = new Set();

  function visit(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const realPath = realpathSync(path);
    if (visited.has(realPath) || isExcluded(realPath, excluded)) return;
    visited.add(realPath);
    if (path !== root && SKIPPED_DIRECTORY_NAMES.has(basename(path))) return;

    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("manifest.json") && names.has("hashes.json")) {
      candidates.push({
        path: realPath,
        relativePath: relative(root, realPath) || ".",
        trustAnchorFingerprint: trustAnchorFingerprint(realPath),
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      visit(resolve(path, entry.name));
    }
  }

  visit(root);
  return {
    root,
    candidates: candidates.sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) || left.path.localeCompare(right.path)
    ),
  };
}
