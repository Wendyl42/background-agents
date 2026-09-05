import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashFile } from "./hash.mjs";
import { stableJson } from "./json.mjs";
import { isPathInside } from "./loader.mjs";

function write(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
}

export function writeAnalysisOutput(inputDir, outputDir, summary, report, extraFiles = {}) {
  const target = resolve(outputDir);
  if (isPathInside(inputDir, target)) {
    throw new Error("Analysis output must be outside the immutable trace bundle");
  }
  if (existsSync(target)) throw new Error(`Analysis output already exists: ${target}`);

  const partial = `${target}.partial-${process.pid}`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    write(join(partial, "summary.json"), stableJson(summary));
    write(join(partial, "report.md"), report);
    write(join(partial, "checkpoint.json"), stableJson(summary.checkpoint));
    const reserved = new Set([
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
    ]);
    for (const [path, content] of Object.entries(extraFiles).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      if (reserved.has(path) || path.includes("/") || path.includes("\\")) {
        throw new Error(`Invalid or reserved analysis artifact path: ${path}`);
      }
      write(join(partial, path), content);
    }
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      ...Object.keys(extraFiles).sort(),
    ].map((path) => ({
      path,
      ...hashFile(join(partial, path)),
    }));
    write(join(partial, "output-hashes.json"), stableJson({ algorithm: "sha256", files }));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(partial, target);
    return target;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
