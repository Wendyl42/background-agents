/** Real provider/runtime smoke test; no control-plane or LLM credentials required. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenSandboxProvider } from "../src/sandbox/providers/opensandbox-provider";

const stateDir = resolve(process.argv[2] ?? ".cache/opensandbox");
const connection = JSON.parse(readFileSync(resolve(stateDir, "connection.json"), "utf8"));
const provider = new OpenSandboxProvider({
  apiUrl: connection.api_url,
  apiKey: connection.api_key,
  image: connection.image,
  scmProvider: "github",
});
const sessionId = `smoke-${randomUUID()}`;
const outputDir = resolve(stateDir, sessionId);
mkdirSync(outputDir);
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sandbox = await provider.createSandbox({
  sessionId,
  sandboxId: sessionId,
  startupAttemptId: randomUUID(),
  repoOwner: null,
  repoName: null,
  controlPlaneUrl: "",
  sandboxAuthToken: "smoke-only",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  timeoutSeconds: 180,
});
assert(sandbox.providerObjectId);
let cleaned = false;
try {
  const deadlineMs = Date.now() + 120_000;
  let containerId = "";
  let runtimeLogs = "";
  while (Date.now() < deadlineMs) {
    containerId = docker(
      "ps",
      "-aq",
      "--filter",
      `label=opensandbox.io/id=${sandbox.providerObjectId}`
    ).trim();
    if (containerId) {
      const logs = docker("logs", containerId);
      runtimeLogs = logs
        .split("\n")
        .filter((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        })
        .join("\n");
      if (runtimeLogs.includes('"sandbox.startup"')) break;
    }
    await wait(1000);
  }
  writeFileSync(resolve(outputDir, "runtime.jsonl"), runtimeLogs + "\n");
  assert(
    runtimeLogs.includes('"sandbox.startup"'),
    "Shared runtime did not finish startup; inspect saved runtime logs"
  );
  const host = JSON.parse(
    docker(
      "inspect",
      "--format",
      '{"container_id":{{json .Id}},"host_pid":{{.State.Pid}},"image_id":{{json .Image}},"labels":{{json .Config.Labels}},"cpu_nanocores":{{.HostConfig.NanoCpus}},"memory_bytes":{{.HostConfig.Memory}}}',
      containerId
    )
  );
  assert.equal(host.labels.openinspect_session_id, sessionId);
  assert(host.host_pid > 0);
  const bindings = JSON.parse(
    docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", containerId)
  );
  for (const addresses of Object.values(bindings) as Array<Array<{ HostIp: string }>>) {
    assert(addresses.every((address) => address.HostIp === "127.0.0.1"));
  }
  const health = docker(
    "exec",
    containerId,
    "python",
    "-c",
    'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:4096/global/health").read().decode())'
  );
  assert.equal(JSON.parse(health).healthy, true);
  writeFileSync(
    resolve(outputDir, "result.json"),
    JSON.stringify(
      {
        session_id: sessionId,
        provider_object_id: sandbox.providerObjectId,
        host,
        runtime_startup: "passed",
        opencode_health: "passed",
        note: "Provider/runtime smoke only; no control-plane or LLM task exercised.",
      },
      null,
      2
    ) + "\n"
  );
} finally {
  const stopped = await provider.stopSandbox({
    providerObjectId: sandbox.providerObjectId,
    sessionId,
    reason: "smoke-cleanup",
  });
  assert.equal(stopped.success, true, stopped.error);
  const response = await fetch(`${connection.api_url}/v1/sandboxes/${sandbox.providerObjectId}`, {
    headers: { "OPEN-SANDBOX-API-KEY": connection.api_key },
  });
  assert.equal(response.status, 404);
  assert.equal(
    docker("ps", "-aq", "--filter", `label=opensandbox.io/id=${sandbox.providerObjectId}`).trim(),
    ""
  );
  cleaned = true;
}
console.log(JSON.stringify({ status: "passed", output: outputDir, cleaned }));
