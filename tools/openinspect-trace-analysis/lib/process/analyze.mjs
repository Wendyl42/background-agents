/** Measured process/exec profile. No shell-string splitting, inferred builtin durations or savings. */
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { loadTraceBundle } from "../loader.mjs";
import { validateTraceBundle } from "../validator.mjs";
import {
  inspectExecutionStream,
  executionQuality,
} from "../../../../scripts/lib/execution-trace.mjs";
import { ns, encoded, elapsed, union, total, distribution } from "./math.mjs";

export const PROCESS_PROFILE = "process-v1";
const BAD_STREAM =
  /^(invalid_|identity_change|duplicate_|missing_open|run_identity_mismatch|outside_expected_tree|boot_registration_mismatch|unmatched_process_exit)/;
const COORDINATION = new Set([
  "task",
  "spawn-child",
  "get-child-status",
  "send-child-prompt",
  "cancel-child",
]);
const compareId = (a, b) => a.id.localeCompare(b.id);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function completeArgv(row) {
  return (
    row.argv_truncated === false &&
    row.argv_encoding_loss === false &&
    Array.isArray(row.argv) &&
    row.argv.length > 0 &&
    row.argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    createHash("sha256")
      .update(row.argv.join("\0") + "\0")
      .digest("hex") === row.argv_sha256
  );
}
const source = (row) => row?.source ?? null;
const interval = (row) => [row.start_ns, row.end_ns];
const opaque = (executable) =>
  /^(?:ba|da|z|fi|k|c)?sh$|^(?:python\d*(?:\.\d+)?|node|bun|ruby|perl|java|dotnet)$/.test(
    basename(executable ?? "")
  );

function counters(row, initial = false) {
  if (!row) return {};
  return {
    runtime: initial
      ? row.initial_cpu_runtime_ns
      : row.cpu_runtime_complete === true
        ? row.cpu_runtime_ns
        : null,
    user: initial ? row.initial_user_cpu_ns : row.cpu_complete === true ? row.user_cpu_ns : null,
    system: initial
      ? row.initial_system_cpu_ns
      : row.cpu_complete === true
        ? row.system_cpu_ns
        : null,
  };
}
function cpuDelta(start, end) {
  const result = {};
  for (const [key, field] of [
    ["runtime", "cpu_runtime_ns"],
    ["user", "user_cpu_ns"],
    ["system", "system_cpu_ns"],
  ])
    result[field] = encoded(elapsed(start[key], end[key]));
  return result;
}
function buildTools(streams) {
  const tools = [];
  for (const stream of streams.filter((s) => s.producer === "opencode_plugin")) {
    const header = stream.records[0],
      ctx = header.context;
    const bySpan = new Map();
    for (const row of stream.records) {
      if (typeof row.span_id !== "string") continue;
      const item = bySpan.get(row.span_id) ?? { id: row.span_id, rows: [] };
      item.rows.push(row);
      bySpan.set(row.span_id, item);
    }
    for (const item of bySpan.values()) {
      const starts = item.rows.filter((r) => r.kind === "tool.start");
      if (starts.length !== 1) continue;
      const start = starts[0],
        ends = item.rows.filter((r) => r.kind === "tool.end");
      const end = ends.length === 1 ? ends[0] : null;
      const terminal = item.rows.find((r) => r.kind === "tool.terminal_observed");
      const identity = item.rows.find((r) => r.kind === "tool.identity");
      const exact =
        start.start_boundary === "tool_execute_before" &&
        end?.end_boundary === "tool_execute_after" &&
        start.session_id === end.session_id &&
        start.call_id === end.call_id &&
        start.clock_id === end.clock_id &&
        ns(start.source_mono_ns) !== null &&
        ns(end.source_mono_ns) !== null;
      const duration = exact ? elapsed(start.source_mono_ns, end.source_mono_ns) : null;
      const mapping = header.clock_mapping;
      const mappingValid =
        header.clock_source === "js_hrtime_calibrated_to_linux_monotonic" &&
        ns(mapping?.uncertainty_ns) !== null &&
        typeof mapping?.offset_ns === "string" &&
        /^-?\d+$/.test(mapping.offset_ns) &&
        [start, ...(end ? [end] : [])].every(
          (row) =>
            ns(row.source_mono_ns) !== null &&
            ns(row.mono_ns) === ns(row.source_mono_ns) + BigInt(mapping.offset_ns)
        );
      tools.push({
        id: item.id,
        stream_id: stream.stream_id,
        inspect_session_id: ctx.inspect_session_id,
        runtime_boot_id: ctx.runtime_boot_id,
        opencode_session_id: start.session_id,
        call_id: start.call_id,
        opencode_message_id: identity?.message_id ?? start.message_id ?? end?.message_id ?? null,
        tool: start.tool,
        identity_quality: start.identity_quality,
        start_boundary: start.start_boundary,
        start_ns: start.mono_ns,
        end_ns: duration !== null ? end.mono_ns : null,
        terminal_observed_ns: terminal?.mono_ns ?? null,
        duration_ns: encoded(duration),
        clock_id: header.clock_id,
        clock_uncertainty_ns: header.clock_mapping?.uncertainty_ns ?? null,
        clock_mapping_valid: mappingValid,
        timing: duration !== null ? "same_producer_execution_hooks" : "exact_end_unavailable",
        status: end?.status ?? terminal?.status ?? "open",
        exit_code: end?.exit_code ?? null,
        coordination: COORDINATION.has(start.tool),
        stream_complete: stream.issues.length === 0,
        sources: [
          source(start),
          source(end),
          source(terminal),
          source(identity),
          source(header),
        ].filter(Boolean),
      });
    }
  }
  return tools.sort(compareId);
}

function buildProcesses(streams, issues) {
  const processes = [],
    stages = [],
    bindings = [];
  for (const stream of streams.filter((s) => s.producer === "ptrace_lifecycle")) {
    const header = stream.records[0],
      context = header.context;
    const starts = stream.records.filter((r) => r.kind === "process.start");
    const rowsByProcess = new Map();
    for (const row of stream.records) {
      if (typeof row.process_instance_id !== "string") continue;
      const list = rowsByProcess.get(row.process_instance_id) ?? [];
      list.push(row);
      rowsByProcess.set(row.process_instance_id, list);
    }
    for (const bind of stream.records.filter((r) => r.kind === "shell.bind"))
      bindings.push({
        stream_id: stream.stream_id,
        span_id: bind.span_id,
        root_process_id: bind.process_instance_id,
        context,
        clock_id: header.clock_id,
        source: source(bind),
        complete: stream.issues.length === 0,
      });
    for (const start of starts) {
      const id = start.process_instance_id;
      if (typeof id !== "string" || typeof start.is_root !== "boolean") {
        issues.push("invalid_process_identity");
        continue;
      }
      const rows = rowsByProcess.get(id);
      const exits = rows.filter((r) => r.kind === "process.exit");
      const end = exits.length === 1 ? exits[0] : null;
      const execs = rows
        .filter((r) => r.kind === "process.exec")
        .sort((a, b) => a.exec_index - b.exec_index);
      let expected = 1,
        valid = true;
      for (const exec of execs) {
        if (exec.exec_index !== expected++) valid = false;
      }
      if (!valid) issues.push(`invalid_exec_sequence:${id}`);
      const points = [{ ...start, exec_index: 0 }, ...execs];
      const process = {
        id,
        stream_id: stream.stream_id,
        inspect_session_id: context.inspect_session_id,
        runtime_boot_id: context.runtime_boot_id,
        opencode_session_id: context.session_id,
        span_id: context.span_id,
        parent_process_id: start.parent_process_instance_id ?? null,
        inherited_from_exec_id: start.inherited_from_exec_id ?? null,
        pid: start.pid,
        birth_ticks: start.birth_ticks,
        is_root: start.is_root,
        clock_id: header.clock_id,
        pid_namespace: header.pid_view_namespace,
        start_ns: start.mono_ns,
        end_ns: end?.mono_ns ?? null,
        lifetime_ns: encoded(elapsed(start.mono_ns, end?.mono_ns)),
        exit_code: end?.exit_code ?? null,
        signal: end?.signal ?? null,
        stream_complete: stream.issues.length === 0,
        exec_sequence_valid: valid,
        sources: [source(start), source(end)].filter(Boolean),
      };
      processes.push(process);
      for (let i = 0; i < points.length; i++) {
        const point = points[i],
          next = points[i + 1] ?? end;
        const infrastructure =
          start.is_root &&
          (i === 0 || (point.exec_index === 1 && basename(point.executable ?? "") === "bash"));
        const duration = valid ? elapsed(point.mono_ns, next?.mono_ns) : null;
        if (next && duration === null) issues.push(`invalid_stage_interval:${id}:${i}`);
        const beginCpu = counters(point, i === 0),
          endCpu = counters(next);
        for (const field of ["runtime", "user", "system"])
          if (
            ns(beginCpu[field]) !== null &&
            ns(endCpu[field]) !== null &&
            ns(endCpu[field]) < ns(beginCpu[field])
          )
            issues.push(`cpu_counter_decreased:${id}:${i}:${field}`);
        stages.push({
          id: `${id}:exec:${point.exec_index}`,
          process_id: id,
          stream_id: stream.stream_id,
          inspect_session_id: context.inspect_session_id,
          runtime_boot_id: context.runtime_boot_id,
          opencode_session_id: context.session_id,
          span_id: context.span_id,
          clock_id: header.clock_id,
          exec_index: point.exec_index,
          kind: infrastructure
            ? i === 0
              ? "launcher"
              : "carrier_shell"
            : i === 0
              ? execs.length
                ? "fork_before_exec"
                : "inherited_image"
              : opaque(point.executable)
                ? "opaque_interpreter"
                : "external_exec",
          infrastructure,
          executable: point.executable ?? null,
          cwd: point.cwd ?? null,
          argv: Array.isArray(point.argv) ? point.argv : null,
          argv_sha256: point.argv_sha256 ?? null,
          argv_complete: completeArgv(point),
          start_ns: point.mono_ns,
          end_ns: next?.mono_ns ?? null,
          duration_ns: encoded(duration),
          end_kind: points[i + 1] ? "exec_replaced" : end ? "process_exit" : "unknown",
          ...cpuDelta(beginCpu, endCpu),
          cpu_tick_resolution_ns: header.cpu_resolution_ns ?? null,
          stream_complete: stream.issues.length === 0,
          exit_code: !points[i + 1] ? (end?.exit_code ?? null) : null,
          signal: !points[i + 1] ? (end?.signal ?? null) : null,
          sources: [source(point), source(next), source(header)].filter(Boolean),
          group_id: null,
        });
      }
    }
  }
  return { processes: processes.sort(compareId), stages: stages.sort(compareId), bindings };
}

function validateProcessTrees(parsed, issues) {
  const counts = new Map(),
    invalid = new Set();
  for (const process of parsed.processes) counts.set(process.id, (counts.get(process.id) ?? 0) + 1);
  const byId = new Map(parsed.processes.map((process) => [process.id, process]));
  const stages = new Map(parsed.stages.map((stage) => [stage.id, stage]));
  const reject = (process, reason) => {
    issues.push(`${reason}:${process.id}`);
    invalid.add(process.stream_id);
  };
  for (const process of parsed.processes) {
    if (counts.get(process.id) !== 1) {
      reject(process, "duplicate_process_identity");
      continue;
    }
    if (!process.exec_sequence_valid) reject(process, "invalid_process_exec_sequence");
    if (process.is_root) {
      if (process.parent_process_id !== null || process.inherited_from_exec_id !== null)
        reject(process, "root_has_parent");
      continue;
    }
    const parent = byId.get(process.parent_process_id),
      inherited = stages.get(process.inherited_from_exec_id);
    if (
      !parent ||
      !inherited ||
      counts.get(parent.id) !== 1 ||
      parent.stream_id !== process.stream_id ||
      inherited.stream_id !== process.stream_id ||
      inherited.process_id !== parent.id ||
      inherited.clock_id !== process.clock_id ||
      ns(process.start_ns) < ns(inherited.start_ns) ||
      (inherited.end_ns !== null && ns(process.start_ns) > ns(inherited.end_ns))
    ) {
      reject(process, "invalid_process_inheritance");
    }
    const seen = new Set([process.id]);
    let ancestor = parent;
    while (ancestor && !ancestor.is_root) {
      if (seen.has(ancestor.id)) {
        reject(process, "process_parent_cycle");
        break;
      }
      seen.add(ancestor.id);
      ancestor = byId.get(ancestor.parent_process_id);
    }
  }
  // A malformed descendant invalidates its stream's group ownership, including
  // ancestors whose totals would otherwise silently omit that descendant.
  return {
    processes: parsed.processes.filter((p) => !invalid.has(p.stream_id)),
    stages: parsed.stages.filter((s) => !invalid.has(s.stream_id)),
    bindings: parsed.bindings.filter((b) => !invalid.has(b.stream_id)),
  };
}

function normalizedRepositories(repositories) {
  if (!Array.isArray(repositories) || !repositories.length) return null;
  if (
    !repositories.every(
      (repo) =>
        repo &&
        typeof repo.repo_owner === "string" &&
        repo.repo_owner.trim() &&
        typeof repo.repo_name === "string" &&
        repo.repo_name.trim() &&
        !repo.repo_name.includes("/") &&
        typeof repo.base_sha === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(repo.base_sha)
    )
  )
    return null;
  return repositories
    .map((repo) => ({
      repo_owner: repo.repo_owner,
      repo_name: repo.repo_name,
      base_sha: repo.base_sha.toLowerCase(),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function repositoryEvidence(bundle, capture) {
  const result = new Map();
  for (const [bootId, boot] of Object.entries(capture?.boots ?? {})) {
    const declared = normalizedRepositories(boot.identity.repositories);
    let invalidObservation = false;
    const observed = bundle.events.flatMap((event, i) => {
      if (
        event.type !== "ready" ||
        event.sessionId !== boot.identity.inspect_session_id ||
        event.data?.runtimeBootId !== bootId
      )
        return [];
      const repos = normalizedRepositories(
        Array.isArray(event.data.repositories)
          ? event.data.repositories.map((repo) => ({
              repo_owner: repo?.repoOwner,
              repo_name: repo?.repoName,
              base_sha: repo?.baseSha,
            }))
          : null
      );
      if (event.data.repositories !== undefined && !repos) invalidObservation = true;
      return repos
        ? [
            {
              repositories: repos,
              source: {
                bundle_fingerprint: bundle.inputFingerprint,
                path: "normalized/events.jsonl",
                line: i + 1,
              },
            },
          ]
        : [];
    });
    const choices = [
      ...(declared ? [declared] : []),
      ...observed.map((entry) => entry.repositories),
    ];
    const consistent =
      !invalidObservation &&
      choices.length &&
      new Set(choices.map((repos) => JSON.stringify(repos))).size === 1;
    result.set(
      bootId,
      consistent
        ? {
            repositories: choices[0],
            sources: [
              ...(declared
                ? [
                    {
                      bundle_fingerprint: bundle.inputFingerprint,
                      path: bundle.manifest.executionTrace.indexFile,
                      json_pointer: `/capture/boots/${bootId}/identity/repositories`,
                    },
                  ]
                : []),
              ...observed.map((entry) => entry.source),
            ],
          }
        : null
    );
  }
  return result;
}

function buildGroups(processes, stages, repositoriesByBoot, issues) {
  const byProcess = new Map(processes.map((p) => [p.id, p]));
  const byStage = new Map(stages.map((s) => [s.id, s]));
  const resolved = new Map();
  function groupFor(process, visiting = new Set()) {
    if (resolved.has(process.id)) return resolved.get(process.id);
    if (visiting.has(process.id)) {
      issues.push("process_parent_cycle");
      return null;
    }
    visiting.add(process.id);
    let groupId;
    if (process.is_root) groupId = `${process.id}:workload`;
    else {
      const parent = byProcess.get(process.parent_process_id);
      const inherited = byStage.get(process.inherited_from_exec_id);
      if (!parent || !inherited) {
        issues.push(`unknown_group_parent:${process.id}`);
        groupId = null;
      } else
        groupId = inherited.infrastructure ? `${process.id}:group` : groupFor(parent, visiting);
    }
    resolved.set(process.id, groupId);
    return groupId;
  }
  const groups = new Map();
  for (const stage of stages.filter((s) => !s.infrastructure)) {
    const process = byProcess.get(stage.process_id),
      id = groupFor(process);
    stage.group_id = id;
    if (!id) continue;
    const group = groups.get(id) ?? { id, stages: [] };
    group.stages.push(stage);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => {
      const parts = group.stages.sort((a, b) =>
        ns(a.start_ns) < ns(b.start_ns) ? -1 : ns(a.start_ns) > ns(b.start_ns) ? 1 : compareId(a, b)
      );
      const rootProcessId = group.id.replace(/:(?:workload|group)$/, ""),
        rootProcess = byProcess.get(rootProcessId);
      const rootStages = parts.filter((s) => s.process_id === rootProcessId);
      const command = rootStages.find((s) => s.exec_index > 0) ?? null;
      const start = parts[0].start_ns;
      const ends = parts.map((s) => ns(s.end_ns));
      const complete =
        ends.every((end) => end !== null) &&
        parts.every((part) => part.duration_ns !== null && part.stream_complete);
      const last = ends.filter((end) => end !== null).reduce((a, b) => (a > b ? a : b), ns(start));
      const runtime = total(parts.map((s) => s.cpu_runtime_ns));
      if (!complete) runtime.total_ns = null;
      const groupTotal = (values) => {
        const metric = total(values);
        if (!complete) metric.total_ns = null;
        return metric;
      };
      const repository = repositoriesByBoot.get(rootProcess.runtime_boot_id);
      const repo = repository?.repositories ?? null;
      const signature =
        command?.argv_complete &&
        command.argv?.every((a) => typeof a === "string") &&
        command.executable &&
        command.cwd &&
        command.argv_sha256 &&
        repo
          ? digest([repo, command.executable, command.cwd, command.argv, command.argv_sha256])
          : null;
      return {
        id: group.id,
        root_process_id: rootProcessId,
        inspect_session_id: rootProcess.inspect_session_id,
        runtime_boot_id: rootProcess.runtime_boot_id,
        opencode_session_id: rootProcess.opencode_session_id,
        span_id: rootProcess.span_id,
        clock_id: rootProcess.clock_id,
        command_stage_id: command?.id ?? null,
        executable: command?.executable ?? rootStages[0]?.executable ?? null,
        start_ns: start,
        end_ns: complete ? encoded(last) : null,
        observed_end_ns: encoded(last),
        elapsed_ns: complete ? encoded(last - ns(start)) : null,
        member_stage_ids: parts.map((s) => s.id),
        member_process_ids: [...new Set(parts.map((s) => s.process_id))].sort(),
        cumulative_process_elapsed: groupTotal(parts.map((s) => s.duration_ns)),
        known_process_union_ns: union(parts.map(interval)).duration_ns,
        self_cpu: runtime,
        user_cpu: groupTotal(parts.map((s) => s.user_cpu_ns)),
        system_cpu: groupTotal(parts.map((s) => s.system_cpu_ns)),
        signature,
        repository_sources: repository?.sources ?? [],
        signature_unavailable_reason: signature
          ? null
          : !repo
            ? "repository_identity_or_revision_missing_or_conflicting"
            : "complete_argv_or_execution_identity_unavailable",
        signature_scope: "declared_repository_identity + executable_path + complete_argv + cwd",
        input_equivalence:
          "unverified: mutable worktree, executable contents and relevant environment are not measured",
        root_exit_code: rootProcess.exit_code,
        root_signal: rootProcess.signal,
        complete: complete && parts.every((s) => s.stream_complete),
        sources: parts.flatMap((s) => s.sources),
      };
    })
    .sort(compareId);
}

function coverage(tools, stages, bindings) {
  return tools.map((tool) => {
    const bound = bindings.filter(
      (b) =>
        b.span_id === tool.id &&
        b.context.inspect_session_id === tool.inspect_session_id &&
        b.context.runtime_boot_id === tool.runtime_boot_id &&
        b.context.session_id === tool.opencode_session_id &&
        b.context.call_id === tool.call_id
    );
    const sameClock = bound.every((b) => b.clock_id === tool.clock_id);
    const streamIds = new Set(bound.map((b) => b.stream_id));
    const work = stages.filter((s) => streamIds.has(s.stream_id) && !s.infrastructure);
    const carrier = stages.filter((s) => streamIds.has(s.stream_id) && s.kind === "carrier_shell");
    const shellWindows = carrier.map(interval).filter(([a, b]) => elapsed(a, b) !== null);
    const shellWindowNs = union(shellWindows).duration_ns;
    const clippedToShell = work.flatMap((s) =>
      shellWindows.flatMap((window) => union([interval(s)], window).intervals)
    );
    const shellUnion = union(clippedToShell).duration_ns;
    const validWindow =
      tool.duration_ns !== null && tool.clock_mapping_valid && sameClock && bound.length > 0;
    const observed = validWindow ? union(work.map(interval), interval(tool)).duration_ns : null;
    const unknown = validWindow ? encoded(ns(tool.duration_ns) - ns(observed)) : null;
    const outside = validWindow
      ? encoded(ns(union(work.map(interval)).duration_ns) - ns(observed))
      : null;
    return {
      span_id: tool.id,
      inspect_session_id: tool.inspect_session_id,
      tool: tool.tool,
      binding_count: bound.length,
      clock_id: tool.clock_id,
      clock_mapping_uncertainty_ns: tool.clock_uncertainty_ns,
      exact_tool_elapsed_ns: tool.duration_ns,
      observed_process_union_ns: observed,
      uncovered_tool_elapsed_ns: unknown,
      observed_work_outside_tool_ns: outside,
      shell_carrier_elapsed_ns: bound.length && sameClock ? shellWindowNs : null,
      observed_union_inside_carrier_ns: bound.length && sameClock ? shellUnion : null,
      uncovered_carrier_elapsed_ns:
        bound.length && sameClock ? encoded(ns(shellWindowNs) - ns(shellUnion)) : null,
      missing_workload_ends: work.filter((s) => s.end_ns === null).length,
      carrier_self_cpu: total(carrier.map((s) => s.cpu_runtime_ns)),
      complete:
        bound.length > 0 &&
        tool.clock_mapping_valid &&
        sameClock &&
        bound.every((b) => b.complete) &&
        work.every((s) => s.duration_ns !== null),
      interpretation:
        "point estimate with declared clock mapping error; uncovered includes shell logic and instrumentation; never critical path or I/O wait",
      sources: [...tool.sources, ...bound.map((b) => b.source)],
    };
  });
}

function repetition(groups, sessions, streams) {
  const sessionParents = new Map(sessions.map((s) => [s.id, s.parentSessionId]));
  const nativeParents = new Map();
  for (const stream of streams)
    for (const row of stream.records) {
      const ctx = stream.records[0].context;
      if (row.kind === "session.identity" && row.parent_session_id)
        nativeParents.set(
          JSON.stringify([ctx.inspect_session_id, ctx.runtime_boot_id, row.session_id]),
          row.parent_session_id
        );
      if (row.kind === "task.link")
        nativeParents.set(
          JSON.stringify([ctx.inspect_session_id, ctx.runtime_boot_id, row.child_session_id]),
          row.session_id
        );
    }
  const candidates = new Map();
  for (const group of groups.filter((g) => g.signature && g.complete)) {
    const families = [];
    const parent = sessionParents.get(group.inspect_session_id);
    if (parent)
      families.push({
        id: `inspect:${parent}`,
        agent: group.inspect_session_id,
        kind: "cross_sandbox_siblings",
      });
    const nativeParent = nativeParents.get(
      JSON.stringify([group.inspect_session_id, group.runtime_boot_id, group.opencode_session_id])
    );
    if (nativeParent)
      families.push({
        id: JSON.stringify([group.inspect_session_id, group.runtime_boot_id, nativeParent]),
        agent: group.opencode_session_id,
        kind: "native_task_siblings",
      });
    for (const family of families) {
      const id = digest([family.id, group.signature]);
      const entry = candidates.get(id) ?? {
        id,
        family: family.id,
        kind: family.kind,
        signature: group.signature,
        groups: [],
        agents: new Set(),
      };
      entry.groups.push(group);
      entry.agents.add(family.agent);
      candidates.set(id, entry);
    }
  }
  return [...candidates.values()]
    .filter((c) => c.agents.size >= 2)
    .map((c) => ({
      id: c.id,
      family: c.family,
      kind: c.kind,
      signature: c.signature,
      agent_ids: [...c.agents].sort(),
      group_ids: c.groups.map((g) => g.id).sort(),
      count: c.groups.length,
      candidate_elapsed: total(c.groups.map((g) => g.elapsed_ns)),
      candidate_cpu: total(c.groups.map((g) => g.self_cpu.total_ns)),
      interpretation: "same-command candidate cost; no proven redundancy or removable latency",
      sources: c.groups.flatMap((g) => g.sources),
      repository_sources: c.groups.flatMap((g) => g.repository_sources),
    }))
    .sort(compareId);
}

export function analyzeProcessBundle(inputPath) {
  const bundle = loadTraceBundle(inputPath),
    validation = validateTraceBundle(bundle);
  if (!validation.valid)
    throw new Error("Invalid base trace bundle; run existing bundle validation first");
  const index = bundle.executionIndex;
  const result = {
    schema_version: "openinspect-process-analysis-v1",
    profile: PROCESS_PROFILE,
    input: {
      root_session_id: bundle.manifest.source.rootSessionId,
      fingerprint: bundle.inputFingerprint,
    },
    status: index ? "available" : "unavailable",
    quality: null,
    issues: [],
    tools: [],
    processes: [],
    stages: [],
    groups: [],
    coverage: [],
    candidates: [],
    session_tree: bundle.sessions.map((s) => ({ id: s.id, parent_id: s.parentSessionId ?? null })),
    coordination: {
      spans: [],
      requests: [],
      messages: [],
      result_available_at: null,
      parent_read_at: null,
      limitation:
        "No structured result-availability/parent-consumption markers; do not infer wait savings from final messages or tool names.",
    },
    evidence: [],
    summary: {},
    checkpoint: { profile: PROCESS_PROFILE, inputFingerprint: bundle.inputFingerprint },
  };
  if (!index) {
    result.summary = {
      status: "unavailable",
      reason: "No fine-grained execution attachment; historical operations cannot be reconstructed",
    };
    return result;
  }
  const streams = index.attachments.map((file) =>
    inspectExecutionStream(readFileSync(join(bundle.bundleDir, file.path)), file.path)
  );
  for (const stream of streams)
    for (const row of stream.records) row.source.bundle_fingerprint = bundle.inputFingerprint;
  result.quality = executionQuality(
    streams,
    index.capture,
    bundle.sessions.map((s) => s.id),
    index.expected_boot_ids
  );
  const streamCounts = new Map();
  for (const stream of streams)
    streamCounts.set(stream.stream_id, (streamCounts.get(stream.stream_id) ?? 0) + 1);
  const usable = streams.filter(
    (s) => streamCounts.get(s.stream_id) === 1 && !s.issues.some((issue) => BAD_STREAM.test(issue))
  );
  if (usable.length !== streams.length) result.issues.push("structurally_damaged_streams_excluded");
  result.tools = buildTools(usable);
  const parsed = validateProcessTrees(buildProcesses(usable, result.issues), result.issues);
  result.processes = parsed.processes;
  result.stages = parsed.stages;
  result.groups = buildGroups(
    result.processes,
    result.stages,
    repositoryEvidence(bundle, index.capture),
    result.issues
  );
  result.coverage = coverage(result.tools, result.stages, parsed.bindings);
  result.candidates = repetition(result.groups, bundle.sessions, usable);
  result.coordination.spans = result.tools
    .filter((tool) => tool.coordination)
    .map((tool) => ({
      span_id: tool.id,
      tool: tool.tool,
      start_ns: tool.start_ns,
      end_ns: tool.end_ns,
      duration_ns: tool.duration_ns,
      clock_id: tool.clock_id,
      sources: tool.sources,
    }));
  result.coordination.requests = bundle.events.flatMap((event, i) =>
    event.type === "tool_call" && event.data?.tool === "get-child-status"
      ? [
          {
            inspect_session_id: event.sessionId,
            child_id: event.data.args?.childId ?? null,
            response_requested: event.data.args?.includeResponse === true,
            control_plane_observed_epoch_ms: event.createdAt,
            clock_domain: "control_plane_epoch_unmapped",
            source: {
              bundle_fingerprint: bundle.inputFingerprint,
              path: "normalized/events.jsonl",
              line: i + 1,
            },
            interpretation:
              "persisted request observation; not proof of response availability or parent consumption",
          },
        ]
      : []
  );
  result.coordination.messages = bundle.messages.map((message, i) => ({
    inspect_session_id: message.sessionId,
    message_id: message.id,
    status: message.status,
    started_epoch_ms: message.startedAt ?? null,
    completed_epoch_ms: message.completedAt ?? null,
    clock_domain: "control_plane_epoch_unmapped",
    source: {
      bundle_fingerprint: bundle.inputFingerprint,
      path: "normalized/messages.jsonl",
      line: i + 1,
    },
  }));
  result.evidence = usable.flatMap((s) => s.records);
  const work = result.stages.filter((s) => !s.infrastructure);
  const covered = result.coverage.filter(
    (c) => c.exact_tool_elapsed_ns !== null && c.observed_process_union_ns !== null && c.complete
  );
  const exactNs = total(covered.map((c) => c.exact_tool_elapsed_ns)).known_ns;
  const unionNs = total(covered.map((c) => c.observed_process_union_ns)).known_ns;
  const candidateIds = new Set(result.candidates.flatMap((c) => c.group_ids));
  result.summary = {
    tool_elapsed: distribution(result.tools.map((t) => t.duration_ns)),
    process_measurement: Object.values(index.capture?.boots ?? {}).some(
      (boot) => boot.identity.mode === "process"
    )
      ? "enabled_for_shell_trees"
      : "unavailable",
    external_exec_elapsed: distribution(
      work.filter((s) => s.exec_index > 0).map((s) => s.duration_ns)
    ),
    process_count: result.processes.length,
    workload_stage_count: work.length,
    command_group_count: result.groups.length,
    cumulative_process_elapsed: total(work.map((s) => s.duration_ns)),
    self_cpu: total(work.map((s) => s.cpu_runtime_ns)),
    self_cpu_scope: "bound shell workload stages; excludes launcher and first carrier shell",
    carrier_self_cpu: total(
      result.stages.filter((s) => s.kind === "carrier_shell").map((s) => s.cpu_runtime_ns)
    ),
    tracee_cpu_after_launcher: total(
      result.stages.filter((s) => s.kind !== "launcher").map((s) => s.cpu_runtime_ns)
    ),
    inline_tool_cpu: "unavailable",
    user_cpu: total(work.map((s) => s.user_cpu_ns)),
    system_cpu: total(work.map((s) => s.system_cpu_ns)),
    coverage: {
      eligible_calls: covered.length,
      excluded_calls: result.coverage.length - covered.length,
      summed_tool_elapsed_ns: exactNs,
      summed_observed_process_union_ns: unionNs,
      ratio: ns(exactNs) > 0n ? Number(ns(unionNs)) / Number(ns(exactNs)) : null,
      denominator:
        "sum of eligible accurately timed shell tool envelopes; concurrent calls may overlap",
    },
    candidate_groups_unique: candidateIds.size,
    candidate_cpu_unique: total(
      result.groups.filter((g) => candidateIds.has(g.id)).map((g) => g.self_cpu.total_ns)
    ),
    opaque_interpreter_stages: work.filter((s) => s.kind === "opaque_interpreter").length,
    semantics:
      "elapsed is not CPU; process union is not critical path; groups are disjoint owners of self CPU; statements inside interpreters remain opaque",
  };
  result.issues = [...new Set(result.issues)].sort();
  if (result.summary.process_measurement === "unavailable") {
    for (const field of [
      "self_cpu",
      "carrier_self_cpu",
      "tracee_cpu_after_launcher",
      "user_cpu",
      "system_cpu",
      "cumulative_process_elapsed",
      "candidate_cpu_unique",
    ])
      result.summary[field] = { known_ns: null, total_ns: null, missing: null };
    result.summary.external_exec_elapsed = {
      known_count: 0,
      missing_count: null,
      p50_ns: null,
      p95_ns: null,
      known_ns: null,
      total_ns: null,
    };
    for (const field of [
      "process_count",
      "workload_stage_count",
      "command_group_count",
      "candidate_groups_unique",
      "opaque_interpreter_stages",
    ])
      result.summary[field] = null;
  }
  result.analysis_complete = result.quality.complete && result.issues.length === 0;
  result.summary.unobserved_work_possible = !result.analysis_complete;
  if (!result.analysis_complete) {
    for (const field of [
      "self_cpu",
      "carrier_self_cpu",
      "tracee_cpu_after_launcher",
      "user_cpu",
      "system_cpu",
      "cumulative_process_elapsed",
    ])
      result.summary[field].total_ns = null;
  }
  return result;
}

export function aggregateProcessReports(reports) {
  const eligible = reports.filter(
    (r) =>
      r.analysis_complete &&
      r.summary.coverage?.ratio !== null &&
      r.summary.coverage?.ratio !== undefined
  );
  const elapsedNs = total(eligible.map((r) => r.summary.coverage.summed_tool_elapsed_ns)).known_ns;
  const coveredNs = total(
    eligible.map((r) => r.summary.coverage.summed_observed_process_union_ns)
  ).known_ns;
  return {
    tasks: reports.length,
    tasks_with_coverage: eligible.length,
    task_equal_mean_coverage: eligible.length
      ? eligible.reduce((a, r) => a + r.summary.coverage.ratio, 0) / eligible.length
      : null,
    workload_weighted_coverage:
      ns(elapsedNs) > 0n ? Number(ns(coveredNs)) / Number(ns(elapsedNs)) : null,
    summed_tool_elapsed_ns: elapsedNs,
    summed_observed_union_ns: coveredNs,
    denominator:
      "each input root tree is one task; unavailable/ineligible tasks excluded with counts; repeated attempts remain separate inputs",
  };
}
