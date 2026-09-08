# OpenSandbox progress / handoff

Updated 2026-09-08. **Delivery complete.** Branch: `dev_opensandbox`; sibling OpenSandbox revision
`5043b353`.

## Delivery and decisions

- Single Linux/Docker host; native OpenSandbox provider and existing shared sandbox runtime.
- Real API-submitted parent/two-child fan-out, returned results, clone/setup, host CPU/memory/I/O,
  container/PID/session mapping, existing trace export/analyzer, failure/timeout cleanup.
- Keep existing provider defaults. No snapshots, repo images, desktop/editor parity, cloud
  deployment, push or merge. No fake model substituted for acceptance.
- Primary implements/fixes; independent `/root/stage1_review` reviews stable code/evidence.
- User supplied DeepSeek key and former Mac Terraform configuration. Imported only GitHub App ID,
  installation ID and PKCS#8 private key; preserved generated local keys. Backend credentials are
  not needed. All credential/input files remain Git-ignored; do not print their contents.

## Running locally

- OpenSandbox server: Docker `oi-opensandbox-server`, loopback port 8090; persisted metadata volume
  `oi-opensandbox-store`. Runtime image `openinspect-runtime:opensandbox`, ID
  `sha256:61e2d455b7802b4e770932e2eeaaf1df80d39b2978a96a9fa3b043173ae12700`.
- Isolated control plane: port 8787, `node packages/opensandbox-infra/control-plane.mjs serve`.
  Private config/state/logs: `.cache/opensandbox/`; no production state/deployment used.
- After host restart, restored Node 22.23.2/npm from the runtime image. For this checkout:
  `export PATH="$PWD/.cache/opensandbox/node/bin:$PATH"`. Earlier `/tmp` tools no longer exist.
- This host's proxy listens only on 127.0.0.1:7890. Optional
  `proxy.py --upstream http://127.0.0.1:7890` relays only on Docker bridge 172.17.0.1:17890. Sandbox
  proxy env is seeded into local encrypted D1; local callbacks and DeepSeek use direct access.
  Container probes to GitHub/npm/PyPI through the relay returned HTTP 200. Proxy log:
  `.cache/opensandbox/proxy.log`.
- Local startup deadline uses `LOCAL_SANDBOX_STARTUP_TIMEOUT_MS`; optional
  `SANDBOX_STARTUP_TIMEOUT_MS` controls both connection watchdog and stale-spawn recovery. Other
  deployments retain the original default. Runtime setup timeout and experiment deadline are
  separate. Do not edit imported source during real runs: Wrangler hot reload interrupts work.
- Full commands and limitations: [README](../packages/opensandbox-infra/README.md).

## Verification and findings

- Shared build, CP/Web typechecks, provider selection, lint/format pass. Final full CP regression:
  **2,776 tests / 179 files**. Latest lifecycle subset: **207 tests**, independently verified.
- Web provider helper: 7 tests; Python toolchain: 5; cleanup/collector: 6; experiment helper: 4.
  Trace exporter tests pass. Analyzer: 86 pass / 20 existing fixture-dependent skips.
- Terraform fmt and isolated validate passed in the earlier stage. Linux random-provider checksum
  was added only to a temporary config/lock copy, not the repository lock. No plan/apply.
- Initial independent reviews fixed lost-create response cleanup, shutdown orphan cleanup,
  OpenSandbox metadata's 63-character limit, loopback published ports, late containers after a
  deadline and refreshed PID identity. Real native TTL, provider/runtime health and warm-only paths
  pass. Key earlier evidence: `native-ttl-result.json`, `down-result.json`, `deadline-fixed`,
  `review-warm-final` under `.cache/opensandbox/`.
- Real DeepSeek testing exposed two acceptance bugs: completed output is stored on `tool_call`, and
  `docker logs --follow` may exit when started before the container runs. Both fixed with
  regressions and independent review. Failed first task is retained as `deepseek-single-1`.
- GitHub App authentication passes; five repositories accessible. Selected
  `Wendyl42/background-agents`, main `c3af07b292339d41e014c324fd50700c4e1b8151`, because it contains
  `.openinspect/setup.sh`. Container direct clone failed (TLS termination); proxy fixes it.
- Real setup exposed the existing 120-second connection watchdog deleting a live installing
  container. Configurable, aligned deadlines now fix this without changing existing defaults.
  Independent review confirms alarm/config wiring. Behavior tests cover long setup surviving the old
  deadline, avoiding duplicate spawns and deleting at the new deadline.

## Real acceptance evidence

All paths below are under `.cache/opensandbox/`; each successful run has `result.json`,
`host-summary.json`, `cleanup.json`, raw observations, trace and analysis.

| Run                      | Result | Evidence                                                                                 |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| `deepseek-single-2`      | Passed | Real exact command and `SINGLE_OK`; host/runtime/cleanup                                 |
| `deepseek-fanout-1`      | Passed | 3 containers/PIDs; 2 child results retrieved; 22,863 ms child message overlap            |
| `deepseek-fanout-2`      | Passed | Repeated successfully; 23,290 ms child message overlap                                   |
| `deepseek-repo-single-4` | Passed | Clone, setup exit 0 (155,390 ms), real model command; startup 162,804 ms                 |
| `deepseek-repo-fanout-1` | Passed | 3 successful clone/setup runs; 2 returned child results; 17,921 ms child message overlap |

- Independent reviewer checked both no-repository fan-out traces, all 24 hashes per trace, exact
  successful child outputs, every parent retrieval, topology, destruction and zero residuals.
- Secret-pattern scans for all five successful traces have no findings. These scans do not replace
  checking task contents before sharing raw traces.
- Negative repository attempts: `deepseek-repo-single-1` (direct GitHub TLS failure), `-2` (old
  watchdog), `-3` (Worker hot reload interrupted POST; no experiment containers observed). Failed
  attempts are not counted as successful acceptance.
- Cold-start condition: fresh containers, locally cached image; execd/OS caches not cleared. Message
  overlap differs from shell-action overlap. Analyzer reports topology/lifecycle/concurrency;
  semantic redundancy analysis is not implemented. Treat these as acceptance observations.

## Final verification / resume

- Model preference updated on 2026-09-08: shared default and current README commands now use
  `deepseek/deepseek-v4-flash`. The five delivery runs above used Pro and remain unchanged. Shared
  build, 13 model-catalog tests and 7 Web model-selection tests pass. A new real task with no
  `--model` override passes: `.cache/opensandbox/deepseek-flash-default-1`; runtime `prompt.start` /
  `prompt.run` confirm Flash, command output is `SINGLE_OK`, and cleanup converges.

- Final independent review passed, with no outstanding must-fix findings. Reviewer verified the
  repository single task and full fan-out, each setup exit code, exact tool results and parent
  retrievals, topology, trace hashes and Docker destruction. Source remained stable during review.
- Repository fan-out setup durations: parent 159,939 ms; children 175,371 / 180,553 ms. Each session
  ran setup exactly once at the same repository SHA. Runtime startup durations: 167,465 / 182,709 /
  188,794 ms. Full experiment execution window: 448,522 ms (excludes cleanup/export).
- Consolidated machine-readable evidence: `.cache/opensandbox/acceptance-summary.json`. Final
  report: `.cache/opensandbox/deepseek-repo-fanout-1/analysis/report.md`.
- All experiment containers are removed. OpenSandbox, the optional proxy relay and local control
  plane remain running. After host restart, start the existing server with
  `docker start oi-opensandbox-server`, then restart the proxy and control-plane commands above.
- No required work or user input remains. Further experiments can use the README's API runner; no
  Web UI submission is required. No production deployment, push or merge performed.
