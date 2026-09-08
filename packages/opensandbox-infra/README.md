# Local OpenSandbox backend

Single-host Linux/Docker backend for OpenInspect research. Each session runs the shared
`sandbox-runtime` in an independent container. The control plane calls OpenSandbox directly; this
backend needs no Modal account. Existing provider defaults remain unchanged.

## Start locally

Run from the repository root with Docker, Python 3.12+, Node 22+ and npm available:

```bash
npm install
npm run build -w @open-inspect/shared
python3 packages/opensandbox-infra/local.py up
python3 packages/opensandbox-infra/local.py build
node packages/opensandbox-infra/control-plane.mjs serve
```

`up` builds the server from `../OpenSandbox` (override with `--source`), using a digest-pinned
release for its dependencies. Keep the source and dependency base compatible when upgrading. The
sibling checkout is not modified. Private connection settings are generated under
`.cache/opensandbox/`; server metadata persists in the `oi-opensandbox-store` Docker volume.

The server and its published sandbox ports bind to `127.0.0.1`. The server image applies a guarded
source overlay because upstream `docker.host_ip` only controls advertised addresses.

`control-plane.mjs` generates a local Wrangler configuration, service authentication keys and a
separate workerd/D1 database, applies the real D1 migrations, and serves port 8787. It binds to all
host interfaces so Docker bridge containers can reach its authenticated callbacks. The callback
address is derived from Docker's bridge gateway. No cloud deployment or Terraform apply is involved.
Stop the foreground control-plane process with Ctrl-C.

After a host restart, use `docker start oi-opensandbox-server` to restart the existing server, then
restart the optional proxy and control plane. To rebuild the server from changed source, run
`local.py down` followed by `local.py up`.

The local launcher sets `SANDBOX_STARTUP_TIMEOUT_MS` from `LOCAL_SANDBOX_STARTUP_TIMEOUT_MS` to
allow repository dependency installation before the runtime connects. This controls both the
connection watchdog and stale-spawn recovery. Other deployments retain their existing default. For
long repository-backed fan-out, also increase the experiment's `--deadline-seconds` to cover parent
setup, child setup and model work; this is separate from sandbox lifetime and hook timeouts.

If Docker Hub is unavailable, official base-image mirrors and public package mirrors can be used:

```bash
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
python3 packages/opensandbox-infra/local.py build \
  --python-image public.ecr.aws/docker/library/python:3.12-slim-bookworm \
  --node-image public.ecr.aws/docker/library/node:22-bookworm-slim \
  --debian-mirror https://mirrors.tuna.tsinghua.edu.cn
```

For a proxy on the Docker host, add `--build-network host`. The build forwards shell proxy
variables; they are not injected into sandbox environments. In this development environment the
public mirrors worked directly after unsetting HTTP/HTTPS proxy variables.

## Configure model and repository access

Local configuration has two private JSON files, both mapping environment names to string values:

- `.cache/opensandbox/control-plane-env.json`: generated local authentication/encryption keys; add
  the existing deployment's required SCM bindings here. Preserve the generated local keys.
- `.cache/opensandbox/sandbox-env.json`: sandbox environment values such as `DEEPSEEK_API_KEY` or
  other credentials supported by the shared runtime. Optional until real model tasks are run.
  Startup validates and encrypts these entries using the application's normal secret format and
  upserts them into local D1. Removing an entry from this file does not delete an existing D1
  secret.

Restart `control-plane.mjs serve` after configuration changes. Repository-backed experiments also
need the deployment's normal SCM access; the runner uses service authentication and the existing
server-side credential resolution. Sandbox network access to the model/SCM endpoints must work. A
proxy inside a sandbox must use a host address reachable from Docker, not host loopback.

For GitHub, add `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` (PKCS#8
PEM, encoded as a JSON string) to `control-plane-env.json`. Reuse an App installed on the experiment
repository. Existing Terraform values `github_app_id`, `github_app_installation_id`, and
`github_app_private_key` supply these bindings; local runs do not need Terraform backend
credentials.

If your existing HTTP proxy listens only on host loopback (common with WSL), optionally run:

```bash
python3 packages/opensandbox-infra/proxy.py --upstream http://127.0.0.1:7890
```

This TCP relay binds only to Docker's bridge gateway and prints its address. Set `HTTPS_PROXY` and
`HTTP_PROXY` in `sandbox-env.json` to that address, and include the bridge gateway, `localhost`,
`127.0.0.1` and any directly reachable API hosts in `NO_PROXY`. Restart the control plane
afterwards. Keep the relay running during experiments; Ctrl-C stops it. Skip this helper if
containers already have the required outbound access. It does not modify system proxy settings.

## Automated validation and experiments

These commands submit through the normal authenticated API; no Web UI task submission is required.
First bundle the two small runners (repeat after changing their sources):

```bash
npx esbuild packages/control-plane/scripts/smoke-opensandbox.ts --bundle --platform=node --format=esm --outfile=.cache/opensandbox/smoke.mjs
npx esbuild packages/control-plane/scripts/run-opensandbox-experiment.ts --bundle --platform=node --format=esm --outfile=.cache/opensandbox/experiment.mjs

# Provider -> runtime -> OpenCode health -> deletion, without a control plane or LLM key.
node .cache/opensandbox/smoke.mjs

# Normal control-plane creation -> runtime WebSocket ready -> host evidence -> cleanup.
# Session creation warms a sandbox even without a prompt. This does not exercise a model.
node .cache/opensandbox/experiment.mjs --warm-only --children 0 --out .cache/opensandbox/warm-1

# Real tasks; choose a model matching your configured credentials.
# Example for DEEPSEEK_API_KEY; every output directory must be new.
node .cache/opensandbox/experiment.mjs --model deepseek/deepseek-v4-flash --children 0 --out .cache/opensandbox/single-1
node .cache/opensandbox/experiment.mjs --model deepseek/deepseek-v4-flash --children 2 --out .cache/opensandbox/fanout-1
node .cache/opensandbox/experiment.mjs --model deepseek/deepseek-v4-flash --children 2 --out .cache/opensandbox/fanout-2

# Add --repo-owner OWNER --repo-name REPO to exercise repository clone/setup.
# Optional: --model MODEL_ID, --deadline-seconds 600, --connection PRIVATE_TRACE_CONNECTION_JSON.
npm run trace:analyze -- .cache/opensandbox/fanout-1/trace --out .cache/opensandbox/fanout-1/analysis
```

The fan-out prompt requests separate `spawn-child` sandboxes, creates every child before waiting,
and asks each child to run the same short Python command. The runner pairs tool calls/results by
message and call ID, verifies the exact command and the parent's retrieval of every child response,
and rejects unexpected descendants. It also checks OpenSandbox ready events, distinct containers,
overlapping child message execution intervals, runtime/host evidence, and deletion. Message overlap
does not itself measure shell-action overlap. Model behavior is not deterministic: a wrong child
count or sequential execution fails acceptance. Full repository setup coverage requires a repository
with a setup script; repository-free smoke runs do not establish that coverage.

Each run saves `run.json`, `result.json`, raw observations, a trace bundle and, on successful
evidence validation, `host-summary.json`. `executionWindowMs` excludes cleanup/export time.
`cleanup.json` records cancellation, discovered sessions, removed containers and cleanup
convergence. Failures and deadlines cancel queued/active work through `/sessions/:id/cancel`, then
continue discovering and deleting owned containers during a bounded window for in-flight creates
before exporting the trace. Ctrl-C requests cleanup; a hard process/host kill relies on server TTL
or `local.py down`.

The cold-start condition is **fresh containers with a locally cached image**. OpenSandbox's execd
cache and OS caches are not cleared. Record model/repository revision, image identity, host load and
resource settings when comparing runs. The minimal image uses `sandbox_runtime/toolchain.json` for
OpenCode/Node pins and stores resolved tool versions at build time. Rebuild after runtime changes.

## Host observations

The experiment runner starts this collector automatically; it can also run independently:

```bash
python3 packages/opensandbox-infra/collect.py --out .cache/opensandbox/observations-1 --duration-seconds 300
```

`host.jsonl` records Docker lifecycle events, image/container identities, host PIDs, CPU counters,
memory, block I/O, networks and process names for OpenInspect sandboxes and the server. It omits
container environment values and process arguments. `runtime.jsonl` wraps structured runtime logs
with container/session identities and Docker timestamps. Runtime/task logs may contain task data;
the output directory is private.

Join host and runtime records by container ID, session ID and startup attempt ID. Full control-plane
sandbox IDs are in runtime records; they exceed OpenSandbox's metadata label length limit. Wall
clock timestamps align records on this host; runtime durations use the runtime's monotonic clock.
Sampling defaults to one second, so short-lived processes/containers may lack samples. CPU counters
are cumulative nanoseconds; sampled peak memory is not an exact lifetime peak. Docker block I/O
counters are container-attributed I/O, not per-action disk latency. Collection adds measurable work
on the host. The existing trace analyzer reports topology, lifecycle and action/setup concurrency;
raw attachments support further host and duplication analysis. Semantic redundancy analysis is not
implemented by the current analyzer.

## Existing deployments and limitations

Provider selection is deployment configuration, not a per-task UI option. The local launcher sets:

```dotenv
SANDBOX_PROVIDER=opensandbox
OPENSANDBOX_API_URL=http://127.0.0.1:8090
OPENSANDBOX_API_KEY=<private connection key>
OPENSANDBOX_IMAGE=openinspect-runtime:opensandbox
```

For a web client, set `NEXT_PUBLIC_SANDBOX_PROVIDER=opensandbox` and point its server/API and
browser WebSocket settings at the same control plane. A cloud control plane needs an independently
reachable HTTPS OpenSandbox origin; the loopback-only local server is not directly reachable from
the cloud. The optional production Terraform bindings configure that external origin, key and image;
they do not provision a host or tunnel. Cloud publishing is separate from the local research setup.

CPU, memory and lifetime use existing sandbox settings. Defaults are defined in the provider;
OpenSandbox requires a lifetime of at least 60 seconds. Snapshot/restore, persistent resume, repo
image builds, code-server, VNC, web terminal and extra tunnel ports are unsupported. Disable those
settings for this backend. The image includes Python, Node, OpenCode/plugin, git, gh and C/C++ build
tools; optional browser/desktop tooling is omitted.

```bash
python3 packages/opensandbox-infra/local.py status
python3 packages/opensandbox-infra/local.py down
```

`down` deletes OpenInspect-labelled sandboxes before stopping the server and its TTL timers. When
the server is unreachable it uses exact ownership labels for Docker cleanup. Other containers and
the metadata volume are preserved. If a create response is lost, the provider attempts bounded
cleanup by startup metadata without repeating POST; provisioning beyond that window relies on TTL.
Keep the server running until those sandboxes expire or use `down`.

Implementation status and actual verification: [progress log](../../docs/OPENSANDBOX_PROGRESS.md).
