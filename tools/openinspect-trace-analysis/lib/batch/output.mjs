import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256Bytes } from "../hash.mjs";
import { stableJson, stableJsonl } from "../json.mjs";

function fileIdentity(content) {
  const bytes = Buffer.from(content);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export function batchArtifactContents({ manifest, runs, failures, aggregate, report }) {
  const artifacts = {
    "batch-manifest.json": stableJson(manifest),
    "runs.jsonl": stableJsonl(runs),
    "failures.jsonl": stableJsonl(failures),
    "aggregate-summary.json": stableJson(aggregate),
    "report.md": report,
  };
  const files = Object.entries(artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, ...fileIdentity(content) }));
  return {
    ...artifacts,
    "output-hashes.json": stableJson({ algorithm: "sha256", files }),
  };
}

function existingOutputMatches(target, artifacts) {
  return Object.entries(artifacts).every(([path, content]) => {
    const file = resolve(target, path);
    return existsSync(file) && readFileSync(file, "utf8") === content;
  });
}

export function writeBatchOutput(outputDir, artifacts) {
  const target = resolve(outputDir);
  if (existsSync(target)) {
    if (!existingOutputMatches(target, artifacts)) {
      throw new Error(`Existing batch output differs from deterministic result: ${target}`);
    }
    return { outputDir: target, reused: true };
  }
  const partial = `${target}.partial-${process.pid}`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    for (const [path, content] of Object.entries(artifacts).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      writeFileSync(resolve(partial, path), content, { mode: 0o600 });
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(partial, target);
    return { outputDir: target, reused: false };
  } catch (error) {
    if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
