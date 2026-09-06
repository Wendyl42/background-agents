/** Backend-neutral trace attachments. Raw bytes are preserved and hashed by the exporter. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
const BACKEND_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function resolveTraceSandboxBackend({ requested, events = [], configured }) {
  const observed = [
    ...new Set(
      events
        .filter((event) => event.type === "ready")
        .map((event) => event.data?.sandboxBackend)
        .filter((backend) => typeof backend === "string" && BACKEND_PATTERN.test(backend))
    ),
  ].sort();
  if (requested && !BACKEND_PATTERN.test(requested))
    throw new Error("Invalid sandbox backend name");
  if (requested && observed.some((backend) => backend !== requested)) {
    throw new Error("Requested sandbox backend conflicts with the run's persisted ready events");
  }
  if (requested) return { backend: requested, source: "explicit", observed };
  if (observed.length) {
    return {
      backend: observed.length === 1 ? observed[0] : "mixed",
      source: "ready_events",
      observed,
    };
  }
  // A collection hint only: the currently deployed backend is not proof of
  // which backend ran a historical session. Keep that limitation visible.
  return {
    backend: configured && BACKEND_PATTERN.test(configured) ? configured : "unknown",
    source: configured ? "deployment_configuration_unverified" : "unknown",
    observed,
  };
}

export function attachSandboxObservations({ outputDir, runtimeLogs = [], hostObservations = [] }) {
  const attachments = [];
  for (const [kind, paths, directory] of [
    ["runtime", runtimeLogs, "sandbox"],
    ["host", hostObservations, "host"],
  ]) {
    for (const [index, inputPath] of paths.entries()) {
      const stat = statSync(inputPath);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `${kind} attachment must be a regular file no larger than ${MAX_ATTACHMENT_BYTES} bytes`
        );
      }
      const bytes = readFileSync(inputPath);
      let records = 0;
      for (const line of bytes.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error(`${kind} attachment contains invalid JSONL at record ${records + 1}`);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`${kind} attachment records must be JSON objects`);
        }
        records += 1;
      }
      const path = `raw/${directory}/${kind}-${String(index + 1).padStart(3, "0")}.jsonl`;
      mkdirSync(join(outputDir, "raw", directory), { recursive: true });
      writeFileSync(join(outputDir, path), bytes, { flag: "wx" });
      attachments.push({ kind, path, records, bytes: bytes.length });
    }
  }
  return {
    status: attachments.length ? "attached" : "unavailable",
    runtimeLogs: attachments.some((file) => file.kind === "runtime") ? "attached" : "unavailable",
    hostObservations: attachments.some((file) => file.kind === "host") ? "attached" : "unavailable",
    coverage:
      "unverified; attachment presence does not establish session or time-series completeness",
    attachments,
  };
}
