# Backend-independent sandbox preparation

This layer keeps session orchestration and runtime observations independent of the sandbox
implementation. It does not add a new provider, host collector, global admission controller,
prewarming policy, or cache optimization.

## Ownership and rollout

Session Durable Object migration 43 adds nullable `sandbox_backend`, `snapshot_backend`, and
`startup_attempt_id` columns. It preserves handles, credentials, snapshots, and existing rows. The
legacy `modal_*` SQL names remain compatibility aliases. Instance and snapshot ownership are
separate because replacing an instance must not relabel an older snapshot.

New create/restore attempts write the backend and a fresh attempt ID atomically with their
authentication identity. Resume rotates the attempt ID without rotating the live sandbox's logical
identity or token. Lifecycle provider operations reject foreign or unknown ownership. This is a
guard, not multi-provider routing: use the original backend to operate an old instance, or start a
new session with the new backend. Snapshots are not portable between backends.

For a deployment with existing handles, explicitly set Terraform `sandbox_legacy_provider`
(`SANDBOX_LEGACY_PROVIDER` in the Worker) to the **verified historical backend**. For example, use
`modal` only if those unlabelled handles are known to come from Modal. This setting never defaults
to `sandbox_provider`. Adoption fills only unknown owners of existing resources and never overwrites
a known owner. Fresh pending rows are not adopted.

Adoption runs lazily when a session lifecycle manager is constructed. Keep the verified legacy
setting while untouched historical sessions still need adoption, including after switching the
active backend. A mixed-history deployment needs per-record verification; do not use a blanket
legacy setting when the historical owner is uncertain. Leaving it empty safely blocks operations on
unlabelled handles rather than guessing. No migration/deployment is performed by local unit tests.

## Runtime baseline

`packages/sandbox-runtime/src/sandbox_runtime/toolchain.json` owns the current baseline pins. Modal
consumes it without upgrading the current OpenCode, plugin, code-server, agent-browser, or ttyd
versions. Other existing providers are not rewritten in this preparation; their older recipes must
not be assumed equivalent to this baseline.

The portable launch contract is:

- Python at least the manifest series; run `python -m sandbox_runtime.entrypoint`.
- Writable `/workspace`; repository checkout directories are `/workspace/<repo_name>`.
- Supply the existing protected `SESSION_CONFIG`, `SANDBOX_ID`, `CONTROL_PLANE_URL`, and
  `SANDBOX_AUTH_TOKEN` contract. Keep LLM `provider` separate from `sandbox_backend`.
- Make runtime code/imports, Git, OpenCode and its matching plugin available. Optional services
  require their binaries, writable config directories and enabled port settings.
- Preserve stdout JSON logs and SIGTERM/SIGINT shutdown handling. Do not add implicit setup or
  warm-up steps in the adapter.

For a full baseline image, run at **image-build time**:

```bash
python -m sandbox_runtime.toolchain --check --capture /app/oi-toolchain.json
```

This records resolved tool/Python-package versions and checks the baseline without starting an agent
or contacting the control plane. Modal now copies the runtime into the image before this step. A
rebuild is required to obtain the inventory and new instrumentation; existing snapshots and prebuilt
images are not silently rebuilt by this change. Do not mix instrumented and older images without
marking missing evidence.

The manifest does not pin every apt/npm dependency: Node is pinned by major, and some ancillary
installers still resolve versions at build time. For experiments, reuse an immutable image, record
its provider ID and OCI digest where available, and retain the resolved inventory.
`runtime.identity` records the actual runtime source SHA-256 (including dirty source changes),
declared toolchain, and the build-time inventory. Missing inventories are reported as unavailable;
declared pins must not be presented as observed versions. The session startup path does not execute
version commands or contact an additional service.

## Failure semantics

`SandboxProviderError.errorType` retains the existing transient/permanent circuit-breaker semantics.
Its separate `reason` defaults to `unknown`. Only a confirmed `image_unavailable` reason permits
prebuilt-image invalidation and the existing single base-image fallback. Network, quota,
authentication, and ambiguous post-create failures do not invalidate images or automatically create
a second sandbox. Error-message text alone is not evidence.

The Modal adapter exposes a structured `error_reason`. Since `Image.from_id` is lazy and a
create-time NOT_FOUND can refer to a secret or app, Modal checks the image alone after a NOT_FOUND
before classifying it as unavailable. This bounded verification is not performed on successful
creates or transport/quota errors. If verification is inconclusive, preserve the original failure.
Other providers may opt into the same error contract when they can provide equally specific
evidence; unknown errors fail closed.

## Attempt and process observations

Control-plane JSON logs use `sandbox_backend`, `session_id`, `sandbox_id`, `startup_attempt_id`, and
`provider_object_id` when known. The `sandbox.startup_phase` event distinguishes attempt start,
provider create/restore/resume start and completion/failure, bridge connection, and receipt of the
runtime's `ready` event. Existing `sandbox.spawn` duration still describes the spawn workflow
through provider completion, not readiness.

Runtime logs carry the **origin** `startup_attempt_id` from `SESSION_CONFIG` and a generated
`runtime_boot_id`, inherited by the bridge subprocess. Live resume preserves process identity;
supervisor restart changes it. Ready events preserve `runtimeBootId` and `runtimeStartupAttemptId`;
the control plane stamps the current `startupAttemptId` and backend. Thus a resumed process can be
joined to a new control-plane attempt without pretending that setup ran again. Reconnection can emit
repeated ready/connection phases for the same attempt; these are not additional boots. Use the first
relevant ready event per attempt for latency.

Runtime startup and setup/start hook durations use a monotonic clock. Absolute timestamps remain
epoch milliseconds. `clock_source` distinguishes control plane and runtime; `clock_id` identifies
the runtime boot. Do not subtract timestamps from different hosts as precise durations without
clock-alignment evidence. Keep API completion, bridge connection, runtime readiness, hook execution,
and first agent action as distinct milestones.

## Trace export and host attachment contract

The existing exporter retains its v0 bundle format, Modal alias, security scan and file hashes. It
chooses a backend using persisted ready events first, or an explicit historical override:

```bash
node scripts/export-openinspect-trace.mjs --session SESSION_ID \
  --sandbox-backend local \
  --runtime-log /path/to/runtime.jsonl \
  --host-observations /path/to/host.jsonl
```

`local` above is a trace label, not a newly implemented provider. Both file options are repeatable.
They copy JSONL objects byte-for-byte into `raw/sandbox/` and `raw/host/`, list them under
`manifest.infrastructureLogs.sandbox`, and include them in normal hash verification and
secret-pattern scanning. Invalid JSONL is rejected. No new live collector or sandbox wake-up is
performed. Treat attached logs as potentially sensitive; the pattern scan is not a guarantee that a
bundle is safe to share.

For old runs without backend evidence, the deployed provider is only an explicitly marked unverified
collection hint. Use `--sandbox-backend` to identify a verified historical backend; an override
conflicting with ready events is rejected. Modal log collection is skipped for non-Modal or mixed
backends. Legacy `--skip-modal-logs` remains supported.

Host collectors added later should include an epoch-ms `ts`, `clock_source`, a host/clock identity,
and session/logical-sandbox/provider-instance mapping. Resource samples should name metric units and
sampling interval; process/cgroup/container mappings need validity intervals to handle identifier
reuse. Retain requested limits separately from effective limits and usage. Image digest, runtime
source identity, repository commits, cache conditions, and configured fan-out limits belong in run
metadata or linked evidence, not inferred from resource usage.

Attachment presence is **not** proof of run coverage, synchronized clocks, or lossless action
transitions. Missing runtime/host evidence stays unavailable. The existing duplication analyzer is
unchanged and does not automatically derive new resource metrics from these attachments. The
optional `sandbox.provenance` metadata object links these artifacts while preserving old metadata
compatibility.

## Local verification

```bash
npm run build -w @open-inspect/shared
npm run typecheck -w @open-inspect/control-plane
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm run test:trace-export
npm run test:trace-analysis
# In each Python package's test environment:
cd packages/modal-infra && pytest tests/ -q
cd ../sandbox-runtime && pytest tests/ -q
```

Tests cover migration/adoption, cross-backend guards, preserved fallback fencing, ambiguous failure
rejection, attempt propagation, runtime identity, attachment hashes and old-bundle compatibility. A
real image build and authenticated Modal session smoke run are separate deployment checks requiring
available credentials and explicit deployment authority.

The runtime test fixture also redirects global Git configuration, credential-wrapper installs, VNC
password files, and X11 cleanup paths into per-test temporary locations. Local regression tests must
not require root or modify a developer's existing sandbox/desktop configuration.
