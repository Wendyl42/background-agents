#!/usr/bin/env node
/* global Buffer, URL, URLSearchParams, console, process, setTimeout */

/**
 * Export a raw-first Open-Inspect session tree without waking its sandboxes.
 *
 * The exporter reads an already-deployed internal service signing secret from
 * Terraform state in memory, signs read-only control-plane requests, walks the
 * root/child session tree, and saves raw API pages plus derived JSONL files.
 * Secrets are never printed or written to the export directory.
 *
 * Usage:
 *   node scripts/export-openinspect-trace.mjs \
 *     --session https://open-inspect-web-...workers.dev/session/<id>
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSandboxObservations, resolveTraceSandboxBackend } from "./lib/sandbox-trace.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_TERRAFORM_DIR = join(PROJECT_ROOT, "terraform/environments/production");
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/export-openinspect-trace.mjs --session <session-id-or-url> [options]

Options:
  --control-plane-url <url>  Override the Terraform control-plane URL
  --terraform-dir <path>     Terraform production directory
  --out <path>               Export directory (must not already exist)
  --transport <mode>         auto (default), curl, or python
  --skip-cloudflare-logs     Do not query Cloudflare historical logs
  --skip-modal-logs          Do not query Modal historical logs
  --sandbox-backend <name>   Historical run backend (checked against ready events)
  --runtime-log <jsonl>      Attach runtime logs; repeat for multiple files
  --host-observations <jsonl> Attach host measurements/mappings; repeat as needed
  --help                     Show this message
`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {
    session: null,
    controlPlaneUrl: null,
    terraformDir: DEFAULT_TERRAFORM_DIR,
    out: null,
    transport: "auto",
    cloudflareLogs: true,
    modalLogs: true,
    sandboxBackend: null,
    runtimeLogs: [],
    hostObservations: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === "--session") args.session = next();
    else if (arg === "--control-plane-url") args.controlPlaneUrl = next();
    else if (arg === "--terraform-dir") args.terraformDir = resolve(next());
    else if (arg === "--out") args.out = resolve(next());
    else if (arg === "--transport") args.transport = next();
    else if (arg === "--skip-cloudflare-logs") args.cloudflareLogs = false;
    else if (arg === "--skip-modal-logs") args.modalLogs = false;
    else if (arg === "--sandbox-backend") args.sandboxBackend = next();
    else if (arg === "--runtime-log") args.runtimeLogs.push(resolve(next()));
    else if (arg === "--host-observations") args.hostObservations.push(resolve(next()));
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`Unknown argument: ${arg}`);
  }

  if (!args.session) usage("--session is required");
  if (!["auto", "curl", "python"].includes(args.transport)) {
    usage("--transport must be auto, curl, or python");
  }
  return args;
}

function parseSessionInput(input) {
  let sessionId = input;
  let webUrl = null;

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    const match = parsed.pathname.match(/^\/session\/([^/]+)\/?$/);
    if (!match) usage("Session URL must have the path /session/<id>");
    sessionId = decodeURIComponent(match[1]);
    webUrl = `${parsed.protocol}//${parsed.host}`;
  }

  if (!SESSION_ID_PATTERN.test(sessionId)) usage("Invalid session ID");
  return { sessionId, webUrl };
}

function walkTerraformModules(module, visit) {
  for (const resource of module?.resources ?? []) visit(resource);
  for (const child of module?.child_modules ?? []) walkTerraformModules(child, visit);
}

function readTerraformDeployment(terraformDir) {
  console.error("Reading deployed configuration from Terraform state...");
  const stdout = execFileSync("terraform", ["show", "-json"], {
    cwd: terraformDir,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = JSON.parse(stdout);
  const outputs = state.values?.outputs ?? {};
  let exportServiceSecret = null;
  let d1DatabaseName = null;

  walkTerraformModules(state.values?.root_module, (resource) => {
    if (resource.address === "random_password.service_auth_secret_github_bot") {
      exportServiceSecret = resource.values?.result ?? null;
    }
    if (resource.address === "cloudflare_d1_database.main") {
      d1DatabaseName = resource.values?.name ?? null;
    }
  });

  if (!exportServiceSecret) {
    throw new Error("Terraform state does not contain the export service signing secret");
  }
  const controlPlaneUrl = outputs.control_plane_url?.value;
  if (typeof controlPlaneUrl !== "string" || !controlPlaneUrl.startsWith("https://")) {
    throw new Error("Terraform state does not contain control_plane_url");
  }

  return {
    exportServiceSecret,
    controlPlaneUrl: controlPlaneUrl.replace(/\/$/, ""),
    controlPlaneWorkerName: outputs.control_plane_worker_name?.value ?? null,
    modalAppName: outputs.modal_app_name?.value ?? "open-inspect",
    sandboxBackend: outputs.sandbox_provider?.value ?? null,
    d1DatabaseId: outputs.d1_database_id?.value ?? null,
    d1DatabaseName,
  };
}

function canonicalizeQuery(search) {
  const entries = Array.from(new URLSearchParams(search).entries());
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(`${left[0]}\0${left[1]}`), Buffer.from(`${right[0]}\0${right[1]}`))
  );
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function serviceAuthHeaders({ service, secret, method, url }) {
  const parsed = new URL(url);
  const timestampMs = Date.now();
  const nonce = randomBytes(8).toString("hex");
  const emptyBodyHash = createHash("sha256").update("").digest("hex");
  const canonical =
    `sig1\n${service}\n${timestampMs}\n${nonce}\n${method.toUpperCase()}\n` +
    `${parsed.pathname}\n${canonicalizeQuery(parsed.search)}\n${emptyBodyHash}\n`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    Accept: "application/json",
    "X-OpenInspect-Service": service,
    "X-OpenInspect-Service-Signature": `sig1.${timestampMs}.${nonce}.${signature}`,
  };
}

const PYTHON_HTTP_GET = String.raw`
import json
import sys

import httpx

url = sys.argv[1]
headers = json.loads(sys.argv[2])

try:
    with httpx.Client(
        timeout=httpx.Timeout(60.0, connect=15.0),
        follow_redirects=False,
        trust_env=True,
    ) as client:
        response = client.get(url, headers=headers)
    print(json.dumps({"status": response.status_code, "body": response.text}))
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    raise SystemExit(2)
`;

function createControlPlaneClient(baseUrl, service, secret, transport = "auto") {
  const retryableCurlExitCodes = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56, 92, 97]);
  const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const retryDelaysMs = [1_000, 2_000, 4_000];
  const pythonRetryDelaysMs = [2_000];
  const python = join(PROJECT_ROOT, "packages/modal-infra/.venv/bin/python");

  function parseJsonBody(text, url) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GET ${new URL(url).pathname} returned invalid JSON`);
    }
  }

  return async function getJson(path) {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    // curl deliberately owns transport here. The deployment workstation may
    // reach workers.dev through HTTP(S)_PROXY; Node's built-in fetch does not
    // consistently honor that environment, while curl does. The only values
    // passed on argv are a short-lived request-bound HMAC and public metadata,
    // never the Terraform secret itself.
    let curlFailure = null;
    if (transport !== "python") {
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        // Sign every attempt independently. Reusing the first signature through
        // a long proxy outage could let it expire before a later retry connects.
        const headers = serviceAuthHeaders({ service, secret, method: "GET", url });
        const response = spawnSync(
          "curl",
          [
            "-sS",
            "--fail-with-body",
            "--connect-timeout",
            "15",
            "--max-time",
            "60",
            "--write-out",
            "\n%{http_code}",
            "-H",
            `Accept: ${headers.Accept}`,
            "-H",
            `X-OpenInspect-Service: ${headers["X-OpenInspect-Service"]}`,
            "-H",
            `X-OpenInspect-Service-Signature: ${headers["X-OpenInspect-Service-Signature"]}`,
            url,
          ],
          {
            encoding: "utf8",
            maxBuffer: MAX_CAPTURE_BYTES,
          }
        );

        const rawOutput = response.stdout || "";
        const statusSeparator = rawOutput.lastIndexOf("\n");
        const text = statusSeparator >= 0 ? rawOutput.slice(0, statusSeparator) : rawOutput;
        const httpStatus = Number.parseInt(
          statusSeparator >= 0 ? rawOutput.slice(statusSeparator + 1) : "0",
          10
        );

        if (response.status === 0) return parseJsonBody(text, url);

        const retryable =
          retryableCurlExitCodes.has(response.status) || retryableHttpStatuses.has(httpStatus);
        const detail = (response.stderr || text).trim().slice(0, 500);
        curlFailure = {
          attemptCount: attempt + 1,
          curlStatus: response.status,
          httpStatus,
          detail,
          retryable,
        };

        if (retryable && attempt < retryDelaysMs.length) {
          const delayMs = retryDelaysMs[attempt];
          console.error(
            `GET ${new URL(url).pathname} failed transiently ` +
              `(curl=${response.status}, http=${httpStatus || "none"}); ` +
              `retrying in ${delayMs / 1_000}s (${attempt + 1}/${retryDelaysMs.length})...`
          );
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          continue;
        }

        if (!retryable || transport === "curl") {
          throw new Error(
            `GET ${new URL(url).pathname} failed after ${attempt + 1} attempt(s) ` +
              `(curl=${response.status}, http=${httpStatus || "none"}): ${detail}`
          );
        }
        break;
      }
    }

    if (!existsSync(python)) {
      const suffix = curlFailure
        ? ` Last curl error: ${curlFailure.detail}`
        : " Python transport was requested.";
      throw new Error(`Python/OpenSSL fallback is unavailable.${suffix}`);
    }

    if (curlFailure) {
      console.error(
        `GET ${new URL(url).pathname} exhausted curl retries; ` +
          "trying Python/OpenSSL proxy fallback..."
      );
    }

    for (let attempt = 0; attempt <= pythonRetryDelaysMs.length; attempt += 1) {
      const headers = serviceAuthHeaders({ service, secret, method: "GET", url });
      const response = spawnSync(python, ["-c", PYTHON_HTTP_GET, url, JSON.stringify(headers)], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: 75_000,
        killSignal: "SIGTERM",
        env: process.env,
      });

      let envelope = null;
      if (response.status === 0) {
        try {
          envelope = JSON.parse(response.stdout);
        } catch {
          throw new Error(
            `Python transport returned an invalid envelope for ${new URL(url).pathname}`
          );
        }
        if (envelope.status >= 200 && envelope.status < 300) {
          return parseJsonBody(envelope.body, url);
        }
      }

      const retryable =
        response.status !== 0 || retryableHttpStatuses.has(Number(envelope?.status ?? 0));
      if (retryable && attempt < pythonRetryDelaysMs.length) {
        const delayMs = pythonRetryDelaysMs[attempt];
        console.error(
          `Python/OpenSSL GET ${new URL(url).pathname} failed transiently; ` +
            `retrying in ${delayMs / 1_000}s...`
        );
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        continue;
      }

      const detail = (
        response.stderr ||
        envelope?.body ||
        response.error?.message ||
        "unknown error"
      )
        .trim()
        .slice(0, 500);
      throw new Error(
        `Python/OpenSSL GET ${new URL(url).pathname} failed after ${attempt + 1} attempt(s) ` +
          `(process=${response.status}, http=${envelope?.status ?? "none"}): ${detail}`
      );
    }

    throw new Error(`GET ${new URL(url).pathname} exhausted all transports`);
  };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeJsonl(path, values) {
  ensureDir(dirname(path));
  const content = values.map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(path, content ? `${content}\n` : "", { mode: 0o600 });
}

function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, value, { mode: 0o600 });
}

async function fetchAllSessions(getJson) {
  const sessions = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getJson(`/sessions?limit=100&offset=${offset}`);
    if (!Array.isArray(page.sessions)) throw new Error("Invalid /sessions response");
    sessions.push(...page.sessions);
    if (!page.hasMore) break;
  }
  return sessions;
}

async function discoverTree(getJson, rootSessionId, sessionIndex) {
  const queue = [rootSessionId];
  const visited = new Set();
  const childrenResponses = new Map();

  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);

    const response = await getJson(`/sessions/${encodeURIComponent(sessionId)}/children`);
    if (!Array.isArray(response.children))
      throw new Error(`Invalid children response for ${sessionId}`);
    childrenResponses.set(sessionId, response);

    for (const child of response.children) {
      const childId = child.id ?? child.sessionId;
      if (!SESSION_ID_PATTERN.test(childId ?? "")) {
        throw new Error(`Invalid child session ID returned for ${sessionId}`);
      }
      if (!sessionIndex.has(childId)) sessionIndex.set(childId, child);
      queue.push(childId);
    }
  }

  return { sessionIds: [...visited], childrenResponses };
}

async function fetchCursorPages(getJson, basePath, limit) {
  const pages = [];
  const items = [];
  const cursors = new Set();
  let cursor = null;

  for (;;) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const page = await getJson(`${basePath}?${query}`);
    pages.push(page);

    const pageItems = page.events ?? page.messages;
    if (!Array.isArray(pageItems)) throw new Error(`Invalid paginated response for ${basePath}`);
    items.push(...pageItems);

    if (!page.hasMore) break;
    if (typeof page.cursor !== "string" || page.cursor.length === 0) {
      throw new Error(`${basePath} reports hasMore without a cursor`);
    }
    if (cursors.has(page.cursor)) throw new Error(`${basePath} repeated a pagination cursor`);
    cursors.add(page.cursor);
    cursor = page.cursor;
  }

  return { pages, items };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function parseTfvarsString(tfvars, key) {
  const match = tfvars.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match?.[1] || null;
}

function captureCloudflareLogs({
  outputDir,
  terraformDir,
  sessionIds,
  sandboxIds,
  earliestCreatedAt,
  experimentEndAt,
}) {
  const tfvarsPath = join(terraformDir, "terraform.tfvars");
  if (!existsSync(tfvarsPath)) return { status: "unavailable", reason: "terraform.tfvars missing" };

  const tfvars = readFileSync(tfvarsPath, "utf8");
  const accountId = parseTfvarsString(tfvars, "cloudflare_account_id");
  const apiToken = parseTfvarsString(tfvars, "cloudflare_api_token");
  if (!accountId || !apiToken) {
    return {
      status: "unavailable",
      reason: "Cloudflare credentials missing from terraform.tfvars",
    };
  }

  const minutesSinceStart = Math.ceil((Date.now() - earliestCreatedAt) / 60_000) + 60;
  const mins = Math.min(Math.max(minutesSinceStart, 60), 10_080);
  const scriptPath = join(PROJECT_ROOT, "scripts/cf-logs.ts");
  const rawCounts = {};
  const counts = {};
  const errors = {};
  const targetedWindowLogs = [];
  const windowFrom = Math.max(0, earliestCreatedAt - 10 * 60_000);
  const windowTo = Math.min(Date.now(), experimentEndAt + 2 * 60 * 60_000);
  const cloudflareEnv = {
    ...process.env,
    NO_COLOR: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
  };

  function runQuery(args) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath, ...args, "--limit", "2000", "--json"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        maxBuffer: MAX_CAPTURE_BYTES,
        env: cloudflareEnv,
      }
    );
    if (result.status !== 0) {
      return {
        logs: [],
        error: (result.stderr || "Cloudflare log query failed").slice(-2000),
      };
    }
    if (!result.stdout.trim()) return { logs: [], error: null };
    try {
      const logs = JSON.parse(result.stdout);
      return { logs: Array.isArray(logs) ? logs : [], error: null };
    } catch {
      return { logs: [], error: "Cloudflare log query returned invalid JSON" };
    }
  }

  for (const sessionId of sessionIds) {
    const query = runQuery(["--session", sessionId, "--mins", String(mins)]);
    const path = join(outputDir, "raw/cloudflare", `${sessionId}.json`);
    if (query.error) {
      errors[`session:${sessionId}`] = query.error;
      writeJson(path, []);
      rawCounts[sessionId] = 0;
      counts[sessionId] = 0;
      continue;
    }

    const logs = query.logs;
    writeJson(path, logs);
    rawCounts[sessionId] = logs.length;
    const sessionWindowLogs = logs.filter(
      (log) =>
        typeof log?.timestamp === "number" &&
        log.timestamp >= windowFrom &&
        log.timestamp <= windowTo
    );
    counts[sessionId] = sessionWindowLogs.length;
    targetedWindowLogs.push(...sessionWindowLogs);
  }

  // Session-filtered queries miss lifecycle/platform entries that carry only
  // a sandbox id (or embed correlation in a nested field). Query the exact
  // experiment window in 15-minute chunks, then retain entries containing a
  // known session or sandbox identity. Chunking prevents newer unrelated logs
  // from displacing an old experiment and exposes saturation at the API's
  // 2,000-event ceiling.
  const identifiers = [...new Set([...sessionIds, ...sandboxIds])];
  const chunkDurationMs = 15 * 60_000;
  const windowLogs = [];
  const windowQueries = [];
  for (let chunkStart = windowFrom, index = 0; chunkStart < windowTo; index += 1) {
    const chunkEnd = Math.min(chunkStart + chunkDurationMs, windowTo);
    const from = new Date(chunkStart).toISOString();
    const until = new Date(chunkEnd).toISOString();
    const query = runQuery(["--all", "--from", from, "--until", until]);
    const queryId = String(index + 1).padStart(3, "0");
    writeJson(join(outputDir, "raw/cloudflare/window-chunks", `${queryId}.json`), query.logs);
    if (query.error) errors[`window:${queryId}`] = query.error;
    const saturated = query.logs.length === 2_000;
    windowQueries.push({ id: queryId, from, until, count: query.logs.length, saturated });
    windowLogs.push(...query.logs);
    chunkStart = chunkEnd;
  }
  writeJson(join(outputDir, "raw/cloudflare/window-queries.json"), { queries: windowQueries });

  const matchedWindowLogs = windowLogs.filter((log) => {
    const serialized = JSON.stringify(log);
    return identifiers.some((identifier) => serialized.includes(identifier));
  });
  const uniqueLogs = new Map();
  for (const log of [...targetedWindowLogs, ...matchedWindowLogs]) {
    const metadataId = log?.["$metadata"]?.id;
    const key = metadataId
      ? `metadata:${metadataId}`
      : `sha256:${createHash("sha256").update(JSON.stringify(log)).digest("hex")}`;
    if (!uniqueLogs.has(key)) uniqueLogs.set(key, log);
  }
  const inWindowLogs = [...uniqueLogs.values()];
  inWindowLogs.sort((left, right) => left.timestamp - right.timestamp);
  writeJsonl(join(outputDir, "normalized/cloudflare-logs.jsonl"), inWindowLogs);

  const errorCount = Object.keys(errors).length;
  const saturatedWindowQueries = windowQueries
    .filter((query) => query.saturated)
    .map((query) => query.id);
  return {
    status:
      errorCount > 0 || saturatedWindowQueries.length > 0
        ? "partial"
        : inWindowLogs.length === 0
          ? "unmatched"
          : "captured",
    lookbackMinutes: mins,
    experimentWindow: {
      from: new Date(windowFrom).toISOString(),
      to: new Date(windowTo).toISOString(),
    },
    rawCounts,
    counts,
    rawCount: Object.values(rawCounts).reduce((sum, count) => sum + count, 0),
    inWindowCount: inWindowLogs.length,
    windowQueryCount: windowQueries.length,
    windowRawCount: windowLogs.length,
    windowMatchedCount: matchedWindowLogs.length,
    saturatedWindowQueries,
    errors,
  };
}

function captureModalLogs({
  outputDir,
  terraformDir,
  appName,
  earliestCreatedAt,
  experimentEndAt,
  sandboxIds,
}) {
  const tfvarsPath = join(terraformDir, "terraform.tfvars");
  const tfvars = existsSync(tfvarsPath) ? readFileSync(tfvarsPath, "utf8") : "";
  const environment = parseTfvarsString(tfvars, "modal_environment") || "main";
  const modal = join(PROJECT_ROOT, "packages/modal-infra/.venv/bin/modal");
  if (!existsSync(modal)) return { status: "unavailable", reason: "Modal CLI missing" };

  const since = new Date(Math.max(0, earliestCreatedAt - 10 * 60_000)).toISOString();
  // A narrow bounded window avoids `modal app logs --tail` returning a newer,
  // unrelated run when the requested experiment happened the previous day.
  // Two hours after the last session update leaves room for inactivity stops
  // and snapshots without pulling the rest of the deployment's history.
  const until = new Date(Math.min(Date.now(), experimentEndAt + 2 * 60 * 60_000)).toISOString();
  const result = spawnSync(
    modal,
    [
      "app",
      "logs",
      appName,
      "--env",
      environment,
      "--since",
      since,
      "--until",
      until,
      "--tail",
      "2000",
      "--timestamps",
      "--show-function-id",
      "--show-function-call-id",
      "--show-container-id",
    ],
    {
      cwd: join(PROJECT_ROOT, "packages/modal-infra"),
      encoding: "utf8",
      maxBuffer: MAX_CAPTURE_BYTES,
      timeout: 45_000,
      killSignal: "SIGTERM",
      env: { ...process.env, NO_COLOR: "1" },
    }
  );

  writeText(join(outputDir, "raw/modal/app-logs.txt"), result.stdout || "");
  writeText(join(outputDir, "raw/modal/app-logs.stderr.txt"), result.stderr || "");
  if (result.status !== 0) {
    return {
      status: result.error?.code === "ETIMEDOUT" ? "timeout" : "error",
      since,
      until,
      exitCode: result.status,
      capturedLineCount: (result.stdout?.match(/\n/g) ?? []).length,
    };
  }
  const matchedSandboxIds = sandboxIds.filter((sandboxId) => result.stdout.includes(sandboxId));
  const matchStatus =
    matchedSandboxIds.length === sandboxIds.length
      ? "captured"
      : matchedSandboxIds.length === 0
        ? "unmatched"
        : "partial";
  return {
    status: matchStatus,
    appName,
    environment,
    since,
    until,
    lineCount: (result.stdout.match(/\n/g) ?? []).length,
    expectedSandboxCount: sandboxIds.length,
    matchedSandboxCount: matchedSandboxIds.length,
    matchedSandboxIds,
  };
}

function listFilesRecursively(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function hashFiles(root, excludedBasenames = new Set()) {
  return listFilesRecursively(root)
    .filter((path) => !excludedBasenames.has(basename(path)))
    .sort()
    .map((path) => ({
      path: relative(root, path),
      bytes: statSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
}

function scanPotentialSecrets(root) {
  const patterns = [
    { name: "private_key", regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/g },
    { name: "github_token", regex: /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g },
    { name: "common_api_key", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
    { name: "authorization_bearer", regex: /Authorization["']?\s*[:=]\s*["']?Bearer\s+\S+/gi },
    {
      name: "secret_assignment",
      regex: /(?:API_KEY|TOKEN|SECRET)["']?\s*[:=]\s*["'][^"']{12,}["']/gi,
    },
  ];
  const findings = [];

  for (const path of listFilesRecursively(root)) {
    if (statSync(path).size > 32 * 1024 * 1024) continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of patterns) {
      const count = [...text.matchAll(pattern.regex)].length;
      if (count > 0) findings.push({ path: relative(root, path), pattern: pattern.name, count });
    }
  }
  return findings;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { sessionId: rootSessionId, webUrl } = parseSessionInput(args.session);
  const deployment = readTerraformDeployment(args.terraformDir);
  const controlPlaneUrl = (args.controlPlaneUrl ?? deployment.controlPlaneUrl).replace(/\/$/, "");
  // `service:web` signatures intentionally require a Better Auth browser
  // session on user routes. A claimless first-party bot service principal is
  // accepted by the read-only user-or-service endpoints and needs no cookie.
  const getJson = createControlPlaneClient(
    controlPlaneUrl,
    "github-bot",
    deployment.exportServiceSecret,
    args.transport
  );

  const outputDir =
    args.out ?? join(PROJECT_ROOT, "traces/openinspect", `${rootSessionId}-${timestampSlug()}`);
  if (existsSync(outputDir)) throw new Error(`Output directory already exists: ${outputDir}`);
  const partialDir = `${outputDir}.partial`;
  if (existsSync(partialDir)) rmSync(partialDir, { recursive: true, force: true });
  ensureDir(partialDir);

  try {
    console.error("Loading the session index...");
    const allSessions = await fetchAllSessions(getJson);
    const sessionIndex = new Map(allSessions.map((session) => [session.id, session]));
    if (!sessionIndex.has(rootSessionId)) {
      throw new Error(`Root session ${rootSessionId} was not found in the session index`);
    }

    console.error("Discovering the parent/child tree...");
    const tree = await discoverTree(getJson, rootSessionId, sessionIndex);
    const sessionIds = tree.sessionIds;
    const treeSessions = sessionIds.map((id) => sessionIndex.get(id) ?? { id });
    writeJson(join(partialDir, "raw/session-index.json"), { sessions: treeSessions });
    for (const [id, response] of tree.childrenResponses) {
      writeJson(join(partialDir, "raw/sessions", id, "children.json"), response);
    }

    const allEvents = [];
    const allMessages = [];
    const sessionReports = [];

    for (const id of sessionIds) {
      console.error(`Exporting session ${id}...`);
      const baseDir = join(partialDir, "raw/sessions", id);
      const [events, messages, artifacts, participants] = await Promise.all([
        fetchCursorPages(getJson, `/sessions/${encodeURIComponent(id)}/events`, 200),
        fetchCursorPages(getJson, `/sessions/${encodeURIComponent(id)}/messages`, 100),
        getJson(`/sessions/${encodeURIComponent(id)}/artifacts`),
        getJson(`/sessions/${encodeURIComponent(id)}/participants`),
      ]);

      writeJsonl(join(baseDir, "event-pages.jsonl"), events.pages);
      writeJsonl(join(baseDir, "message-pages.jsonl"), messages.pages);
      writeJson(join(baseDir, "artifacts.json"), artifacts);
      writeJson(join(baseDir, "participants.json"), participants);

      const metadata = sessionIndex.get(id) ?? { id };
      const eventIdDuplicates = duplicateValues(events.items.map((event) => event.id));
      const messageIdDuplicates = duplicateValues(messages.items.map((message) => message.id));
      sessionReports.push({
        sessionId: id,
        parentSessionId: metadata.parentSessionId ?? null,
        spawnDepth: metadata.spawnDepth ?? null,
        status: metadata.status ?? null,
        eventCount: events.items.length,
        eventPageCount: events.pages.length,
        messageCount: messages.items.length,
        messagePageCount: messages.pages.length,
        eventIdDuplicates,
        messageIdDuplicates,
      });

      for (const event of events.items) {
        allEvents.push({
          rootSessionId,
          sessionId: id,
          parentSessionId: metadata.parentSessionId ?? null,
          spawnDepth: metadata.spawnDepth ?? null,
          ...event,
        });
      }
      for (const message of messages.items) {
        allMessages.push({
          rootSessionId,
          sessionId: id,
          parentSessionId: metadata.parentSessionId ?? null,
          spawnDepth: metadata.spawnDepth ?? null,
          ...message,
        });
      }
    }

    allEvents.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    );
    allMessages.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    );
    writeJsonl(join(partialDir, "normalized/events.jsonl"), allEvents);
    writeJsonl(join(partialDir, "normalized/messages.jsonl"), allMessages);
    writeJsonl(
      join(partialDir, "normalized/actions.jsonl"),
      allEvents.filter((event) => event.type !== "token")
    );

    const earliestCreatedAt = Math.min(
      ...treeSessions.map((session) => session.createdAt).filter(Number.isFinite),
      Date.now()
    );
    const latestSessionUpdatedAt = Math.max(
      ...treeSessions.map((session) => session.updatedAt).filter(Number.isFinite),
      earliestCreatedAt
    );
    // Session-index updatedAt is lifecycle metadata, not an experiment clock:
    // reopening, read-state changes, or later maintenance can move it days
    // after the agent finished. Bound telemetry with persisted event/message
    // completion time instead so an old session does not query a week of
    // unrelated infrastructure logs.
    const experimentEndAt = Math.max(
      ...allEvents.map((event) => event.createdAt).filter(Number.isFinite),
      ...allMessages
        .map((message) => message.completedAt ?? message.startedAt ?? message.createdAt)
        .filter(Number.isFinite),
      earliestCreatedAt
    );
    const sandboxIds = [
      ...new Set(
        allEvents
          .filter((event) => event.type === "ready")
          .map((event) => event.data?.sandboxId)
          .filter((sandboxId) => typeof sandboxId === "string" && sandboxId.length > 0)
      ),
    ];

    console.error("Capturing infrastructure logs...");
    const sandboxBackend = resolveTraceSandboxBackend({
      requested: args.sandboxBackend,
      events: allEvents,
      configured: deployment.sandboxBackend,
    });
    const sandboxObservations = attachSandboxObservations({
      outputDir: partialDir,
      runtimeLogs: args.runtimeLogs,
      hostObservations: args.hostObservations,
    });
    const cloudflare = args.cloudflareLogs
      ? captureCloudflareLogs({
          outputDir: partialDir,
          terraformDir: args.terraformDir,
          sessionIds,
          sandboxIds,
          earliestCreatedAt,
          experimentEndAt,
        })
      : { status: "skipped" };
    const modal =
      sandboxBackend.backend !== "modal"
        ? { status: "not_applicable" }
        : args.modalLogs
          ? captureModalLogs({
              outputDir: partialDir,
              terraformDir: args.terraformDir,
              appName: deployment.modalAppName,
              earliestCreatedAt,
              experimentEndAt,
              sandboxIds,
            })
          : { status: "skipped" };

    const parentMismatches = treeSessions
      .filter((session) => session.id !== rootSessionId)
      .filter((session) => !sessionIds.includes(session.parentSessionId))
      .map((session) => ({ sessionId: session.id, parentSessionId: session.parentSessionId }));
    const eventTypes = Object.fromEntries(
      Object.entries(
        allEvents.reduce((counts, event) => {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          return counts;
        }, {})
      ).sort()
    );

    const completeness = {
      rootSessionId,
      sessionCount: sessionIds.length,
      sessionIds,
      parentMismatches,
      sessions: sessionReports,
      eventCount: allEvents.length,
      messageCount: allMessages.length,
      eventTypes,
      compositeEventIdDuplicates: duplicateValues(
        allEvents.map((event) => `${event.sessionId}:${event.id}`)
      ),
      compositeMessageIdDuplicates: duplicateValues(
        allMessages.map((message) => `${message.sessionId}:${message.id}`)
      ),
    };
    writeJson(join(partialDir, "completeness.json"), completeness);

    const missingness = {
      durableObjectEvents: "captured for every discovered session",
      sessionTree: "captured from D1-backed children endpoints",
      stepStartAndStepFinish:
        "not durably persisted by the current control plane; only broadcast live",
      tokenDeltas:
        "not lossless; token events are upserted to cumulative snapshots per message/compaction segment",
      toolCallStateTransitions:
        "not lossless; repeated states of one tool identity are upserted to the latest payload",
      heartbeatEvents: "not persisted",
      openCodeRawMessages:
        "not captured because sandboxes were closed; snapshot restore may recover final message state but would wake sandboxes",
      liveSseArrivalOrder: "not recoverable after the run",
      infrastructureResourceTimeSeries:
        sandboxObservations.hostObservations === "attached"
          ? "host observations attached; coverage, clocks, and resource attribution require validation"
          : "unavailable; sandbox logs do not imply CPU/memory time-series coverage",
      sandboxBackend,
      runtimeLogs: sandboxObservations.runtimeLogs,
      hostObservations: sandboxObservations.hostObservations,
      cloudflareLogs: cloudflare.status,
      modalLogs: modal.status,
    };
    writeJson(join(partialDir, "missingness.json"), missingness);

    const securityFindings = scanPotentialSecrets(partialDir);
    writeJson(join(partialDir, "security-scan.json"), {
      note: "Pattern matches are counts only. Review before sharing the raw trace.",
      findings: securityFindings,
    });

    const hashes = hashFiles(partialDir, new Set(["manifest.json", "hashes.json"]));
    writeJson(join(partialDir, "hashes.json"), { algorithm: "sha256", files: hashes });
    writeJson(join(partialDir, "manifest.json"), {
      schemaVersion: "openinspect-trace-v0",
      exportedAt: new Date().toISOString(),
      source: {
        rootSessionId,
        webUrl,
        controlPlaneUrl,
        repository: treeSessions[0]
          ? `${treeSessions[0].repoOwner ?? ""}/${treeSessions[0].repoName ?? ""}`
          : null,
      },
      deployment: {
        controlPlaneWorkerName: deployment.controlPlaneWorkerName,
        d1DatabaseId: deployment.d1DatabaseId,
        d1DatabaseName: deployment.d1DatabaseName,
        modalAppName: deployment.modalAppName,
        sandboxBackend: deployment.sandboxBackend,
      },
      interval: {
        earliestSessionCreatedAt: earliestCreatedAt,
        experimentEndAt,
        latestSessionUpdatedAt,
      },
      counts: {
        sessions: sessionIds.length,
        events: allEvents.length,
        messages: allMessages.length,
      },
      infrastructureLogs: {
        cloudflare,
        modal, // Legacy alias retained for existing trace consumers.
        sandbox: { ...sandboxBackend, ...sandboxObservations, providerLogs: modal },
      },
      limitationsFile: "missingness.json",
      completenessFile: "completeness.json",
      securityScanFile: "security-scan.json",
      hashesFile: "hashes.json",
    });

    ensureDir(dirname(outputDir));
    renameSync(partialDir, outputDir);
    console.error(`Trace export complete: ${outputDir}`);
    console.log(outputDir);
  } catch (error) {
    const partialFiles = listFilesRecursively(partialDir);
    if (partialFiles.length === 0) {
      rmSync(partialDir, { recursive: true, force: true });
      console.error("Trace export failed before any data was written; empty partial removed.");
    } else {
      console.error(`Trace export failed; partial data kept at ${partialDir}`);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
