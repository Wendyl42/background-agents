import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { scenario, bundleFixture, cpu } from "./process/fixture.mjs";
import { analyzeProcessBundle, aggregateProcessReports } from "../lib/process/analyze.mjs";
import { writeProcessAnalysis } from "../lib/process/output.mjs";
import { renderProcessHtml, csv } from "../lib/process/report.mjs";
import { createSyntheticBundle } from "./fixture.mjs";

function setup(t, scenarios, options) {
  const root = mkdtempSync(join(tmpdir(), "oi-process-analysis-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = bundleFixture(join(root, "bundle"), scenarios, options);
  return { root, path, report: analyzeProcessBundle(path) };
}
test("parallel commands preserve overlapping elapsed, union and self CPU without carrier coverage", (t) => {
  const { report: r } = setup(t);
  assert.equal(r.quality.complete, true);
  assert.equal(r.summary.tool_elapsed.p50_ns, cpu(100));
  assert.equal(r.summary.cumulative_process_elapsed.total_ns, cpu(90));
  assert.equal(r.summary.self_cpu.total_ns, cpu(30));
  assert.equal(r.coverage[0].observed_process_union_ns, cpu(70));
  assert.equal(r.coverage[0].uncovered_tool_elapsed_ns, cpu(30));
  assert.equal(r.coverage[0].uncovered_carrier_elapsed_ns, cpu(29));
  assert.equal(r.groups.length, 2);
  assert.ok(BigInt(r.stages[0].start_ns) > BigInt(Number.MAX_SAFE_INTEGER));
});
test("serial commands and builtin-only calls have honest denominators", (t) => {
  const { report: r } = setup(t, [
    scenario({
      ops: [
        { id: "a", start: 10, exec: 12, end: 50, cpu: 10 },
        { id: "b", start: 60, exec: 61, end: 80, cpu: 5 },
      ],
    }),
  ]);
  assert.equal(r.coverage[0].observed_process_union_ns, cpu(60));
  const { report: b } = setup(t, [scenario({ ops: [] })]);
  assert.equal(b.summary.workload_stage_count, 0);
  assert.equal(b.coverage[0].observed_process_union_ns, "0");
  assert.equal(b.coverage[0].uncovered_tool_elapsed_ns, cpu(100));
  assert.equal(b.coverage[0].uncovered_carrier_elapsed_ns, cpu(99));
  assert.equal(b.summary.coverage.ratio, 0);
});
test("nested worker CPU is counted once; thread-exit counters are not added to process snapshots", (t) => {
  const { report: r } = setup(t, [
    scenario({
      ops: [
        { id: "a", start: 10, exec: 12, end: 90, cpu: 10, exe: "/usr/bin/npm" },
        {
          id: "worker",
          parent: "a",
          start: 20,
          exec: 21,
          end: 70,
          cpu: 8,
          exe: "/usr/bin/python",
          extraThreadExit: 500,
        },
        { id: "b", start: 30, exec: 31, end: 80, cpu: 20 },
      ],
    }),
  ]);
  assert.equal(r.groups.length, 2);
  assert.equal(r.summary.self_cpu.total_ns, cpu(38));
  const group = r.groups.find((g) => g.executable === "/usr/bin/npm");
  assert.equal(group.self_cpu.total_ns, cpu(18));
  assert.equal(group.member_process_ids.length, 2);
  assert.equal(group.elapsed_ns, cpu(80));
  assert.equal(r.summary.cumulative_process_elapsed.total_ns, cpu(180));
});
test("root exec into workload is included while prior launcher/carrier CPU is excluded", (t) => {
  const { report: r } = setup(t, [
    scenario({
      rootExec: { at: 40, cpu: 130, finalCpu: 170 },
      ops: [
        { id: "a", start: 10, exec: 11, end: 50, cpu: 5 },
        { id: "worker", parentExec: 2, start: 60, exec: 61, end: 80, cpu: 10 },
      ],
    }),
  ]);
  const workload = r.stages.find((s) => s.process_id === "p:r" && s.exec_index === 2);
  assert.equal(workload.infrastructure, false);
  assert.equal(workload.cpu_runtime_ns, cpu(40));
  assert.equal(r.summary.self_cpu.total_ns, cpu(55));
  assert.equal(r.coverage[0].observed_process_union_ns, cpu(90));
  assert.equal(r.groups.find((g) => g.id === "p:r:workload").self_cpu.total_ns, cpu(50));
});
test("background and missing ends are kept distinct from complete tool windows", (t) => {
  const { report: r } = setup(t, [
    scenario({ ops: [{ id: "bg", start: 10, exec: 11, end: 150, cpu: 5 }] }),
  ]);
  assert.equal(r.coverage[0].observed_work_outside_tool_ns, cpu(50));
  assert.equal(r.groups[0].elapsed_ns, cpu(140));
  const { report: m } = setup(t, [
    scenario({ ops: [{ id: "bg", start: 10, exec: 11, end: null, cpu: 5 }] }),
  ]);
  assert.equal(m.quality.complete, false);
  assert.equal(m.groups[0].elapsed_ns, null);
  assert.equal(m.summary.self_cpu.total_ns, null);
  assert.equal(m.coverage[0].missing_workload_ends, 1);
  assert.equal(m.summary.coverage.eligible_calls, 0);
});
test("same numeric PID has separate process instances and no-exec children remain observed", (t) => {
  const { report: r } = setup(t, [
    scenario({
      ops: [
        { id: "first", pid: 7, start: 10, exec: 11, end: 20, cpu: 2 },
        { id: "second", pid: 7, start: 30, exec: null, end: 60, cpu: 3 },
      ],
    }),
  ]);
  assert.equal(r.processes.filter((p) => p.pid === 7).length, 2);
  assert.equal(r.summary.self_cpu.total_ns, cpu(5));
  assert.ok(r.stages.some((s) => s.kind === "inherited_image" && s.duration_ns === cpu(30)));
});
test("event-observed terminals and cross-clock overlap never become exact tool coverage", (t) => {
  const { report: r } = setup(t, [scenario({ exact: false })]);
  assert.equal(r.tools[0].duration_ns, null);
  assert.equal(r.coverage[0].observed_process_union_ns, null);
  const { report: c } = setup(t, [scenario({ toolClock: "another-domain" })]);
  assert.equal(c.tools[0].duration_ns, cpu(100));
  assert.equal(c.coverage[0].observed_process_union_ns, null);
  assert.equal(c.summary.coverage.ratio, null);
});
test("strict signatures identify sibling candidates but do not infer redundant or saved cost", (t) => {
  const sessions = [
    { id: "root", parentSessionId: null, spawnDepth: 0 },
    { id: "one", parentSessionId: "root", spawnDepth: 1 },
    { id: "two", parentSessionId: "root", spawnDepth: 1 },
  ];
  const ops = [{ id: "a", start: 10, exec: 11, end: 50, cpu: 5, argv: ["job", "same"] }];
  const { report: r } = setup(
    t,
    [
      scenario({ name: "root", ops: [] }),
      scenario({ name: "one", session: "one", ops }),
      scenario({ name: "two", session: "two", ops }),
    ],
    { sessions }
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].count, 2);
  assert.equal(r.candidates[0].candidate_cpu.total_ns, cpu(10));
  assert.equal(r.summary.candidate_groups_unique, 2);
  assert.equal(r.candidates[0].saved_latency_ns, undefined);
  const { report: truncated } = setup(
    t,
    [
      scenario({ name: "root", ops: [] }),
      scenario({ name: "one", session: "one", ops }),
      scenario({
        name: "two",
        session: "two",
        ops: [{ ...ops[0], imageFields: { argv_truncated: true } }],
      }),
    ],
    { sessions }
  );
  assert.equal(truncated.candidates.length, 0);
});
test("native Task siblings have an explicit same-sandbox family", (t) => {
  const { report: r } = setup(t, [
    scenario({ name: "one", ocSession: "oc-one", taskParent: "oc-parent" }),
    scenario({ name: "two", ocSession: "oc-two", taskParent: "oc-parent" }),
  ]);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].kind, "native_task_siblings");
  assert.equal(r.summary.candidate_groups_unique, 4);
});
test("task equal and workload weighted coverage retain separate denominators", (t) => {
  const a = setup(t, [scenario({ ops: [] })]).report;
  const b = setup(t, [
    scenario({
      toolEnd: 1000,
      rootEnd: 1000,
      ops: [{ id: "a", start: 100, exec: 101, end: 900, cpu: 1 }],
    }),
  ]).report;
  const aggregate = aggregateProcessReports([a, b]);
  assert.equal(aggregate.task_equal_mean_coverage, 0.4);
  assert.ok(Math.abs(aggregate.workload_weighted_coverage - 800 / 1100) < 1e-12);
});

test("tool-only capture keeps process costs unavailable and carrier CPU remains separately visible", (t) => {
  const { report: r } = setup(t, [scenario({ mode: "tools" })]);
  assert.equal(r.tools[0].duration_ns, cpu(100));
  assert.equal(r.summary.process_count, null);
  assert.equal(r.summary.self_cpu.known_ns, null);
  const { report: b } = setup(t, [scenario({ ops: [] })]);
  assert.equal(b.summary.self_cpu.total_ns, "0");
  assert.equal(b.summary.carrier_self_cpu.total_ns, cpu(9));
  assert.equal(b.summary.tracee_cpu_after_launcher.total_ns, cpu(9));
});

test("uncalibrated or inconsistent clock mappings cannot authorize tool/process overlap", (t) => {
  const { report: r } = setup(t, [scenario()], {
    mutate(stream) {
      if (stream.name.startsWith("tools")) stream.rows[0].clock_mapping.offset_ns = "0";
    },
  });
  assert.equal(r.tools[0].duration_ns, cpu(100));
  assert.equal(r.tools[0].clock_mapping_valid, false);
  assert.equal(r.coverage[0].observed_process_union_ns, null);
  assert.equal(r.summary.coverage.ratio, null);
});

test("decreasing resource counters are unknown, and incomplete tasks do not enter equal-weight aggregates", (t) => {
  const { report: r } = setup(t, [
    scenario({ ops: [{ id: "a", start: 10, exec: 11, end: 50, cpu: 1, preCpu: 5 }] }),
  ]);
  assert.equal(r.summary.self_cpu.total_ns, null);
  assert.ok(r.issues.some((issue) => issue.startsWith("cpu_counter_decreased")));
  assert.equal(aggregateProcessReports([r]).tasks_with_coverage, 0);
  const { report: missing } = setup(t, [scenario()], {
    mutate(stream) {
      if (stream.name.startsWith("process")) stream.rows.pop();
    },
  });
  assert.equal(missing.summary.self_cpu.known_ns, cpu(30));
  assert.equal(missing.summary.self_cpu.total_ns, null);
  assert.equal(missing.groups[0].elapsed_ns, null);
  assert.equal(aggregateProcessReports([missing]).tasks_with_coverage, 0);
});

test("output cannot write through a symlink into immutable input evidence", (t) => {
  const { root, path } = setup(t);
  symlinkSync(path, join(root, "alias"));
  assert.throws(
    () => writeProcessAnalysis([path], join(root, "alias/new-analysis")),
    /outside input/
  );
});

test("wrong or temporally impossible inheritance quarantines the whole stream, including ancestors", (t) => {
  const nested = [
    { id: "a", start: 10, exec: 11, end: 90, cpu: 5 },
    { id: "worker", parent: "a", start: 20, exec: 21, end: 70, cpu: 3 },
  ];
  for (const inherited of ["p:r:exec:1", "p:a:exec:0"]) {
    const { report: r } = setup(t, [scenario({ ops: nested })], {
      mutate(stream) {
        const row = stream.rows.find(
          (row) => row.kind === "process.start" && row.process_instance_id === "p:worker"
        );
        if (row) row.inherited_from_exec_id = inherited;
      },
    });
    assert.equal(r.analysis_complete, false);
    assert.ok(r.issues.some((issue) => issue.startsWith("invalid_process_inheritance")));
    assert.equal(r.groups.length, 0);
    assert.equal(r.summary.self_cpu.total_ns, null);
  }
});

test("cross-stream process identity collisions cannot merge command groups", (t) => {
  const fixtures = [scenario({ name: "one" }), scenario({ name: "two" })];
  const { report: r } = setup(t, fixtures, {
    mutate(stream) {
      if (!stream.name.startsWith("process")) return;
      for (const row of stream.rows)
        for (const key of [
          "process_instance_id",
          "parent_process_instance_id",
          "inherited_from_exec_id",
        ])
          if (typeof row[key] === "string")
            row[key] = row[key].replace(/^(one|two):/, "collision:");
    },
  });
  assert.equal(r.analysis_complete, false);
  assert.ok(r.issues.some((issue) => issue.startsWith("duplicate_process_identity")));
  assert.equal(r.groups.length, 0);
});

test("strict repository matching rejects unknown scope/revision and accepts only boot-matched observed baselines", (t) => {
  const sessions = [
    { id: "root", parentSessionId: null, spawnDepth: 0 },
    { id: "one", parentSessionId: "root", spawnDepth: 1 },
    { id: "two", parentSessionId: "root", spawnDepth: 1 },
  ];
  const fixtures = () => [
    scenario({ name: "root", ops: [] }),
    scenario({ name: "one", session: "one" }),
    scenario({ name: "two", session: "two" }),
  ];
  for (const repositories of [
    [],
    [{ repo_owner: null, repo_name: null, base_sha: null }],
    [{ repo_owner: "group/subgroup", repo_name: "repo", base_sha: null }],
  ]) {
    const { report: r } = setup(t, fixtures(), { sessions, repositories });
    assert.equal(r.candidates.length, 0);
    assert.ok(r.groups.every((g) => g.signature === null));
  }
  const ready = (id, boot, sha) => ({
    id: "ready-" + id + "-" + sha,
    sessionId: id,
    type: "ready",
    createdAt: 1000,
    data: {
      runtimeBootId: boot,
      repositories: [{ repoOwner: "group/subgroup", repoName: "repo", baseSha: sha }],
    },
  });
  const events = [
    ready("one", "boot-one", "a".repeat(40)),
    ready("two", "boot-two", "a".repeat(40)),
  ];
  const { report: matched } = setup(t, fixtures(), { sessions, repositories: [], events });
  assert.equal(matched.candidates.length, 1);
  assert.ok(
    matched.candidates[0].repository_sources.every(
      (ref) => ref.path === "normalized/events.jsonl" && ref.line
    )
  );
  const { report: conflict } = setup(t, fixtures(), {
    sessions,
    repositories: [],
    events: [...events, ready("two", "boot-two", "b".repeat(40))],
  });
  assert.equal(conflict.candidates.length, 0);
  const { report: wrongBoot } = setup(t, fixtures(), {
    sessions,
    repositories: [],
    events: [events[0], ready("two", "other-boot", "a".repeat(40))],
  });
  assert.equal(wrongBoot.candidates.length, 0);
});
test("old bundles remain unavailable, output is deterministic and raw Top-N references resolve", (t) => {
  const { root, path, report } = setup(t);
  const old = createSyntheticBundle(join(root, "old"));
  assert.equal(analyzeProcessBundle(old).status, "unavailable");
  const a = writeProcessAnalysis([path], join(root, "a")),
    b = writeProcessAnalysis([path], join(root, "b"));
  for (const file of readdirSync(a))
    assert.deepEqual(readFileSync(join(a, file)), readFileSync(join(b, file)), file);
  for (const group of report.groups)
    for (const ref of group.sources) {
      const raw = JSON.parse(readFileSync(join(path, ref.path), "utf8").split("\n")[ref.line - 1]);
      assert.equal(raw.schema, "openinspect-execution-v1");
      assert.equal(ref.bundle_fingerprint, report.input.fingerprint);
    }
});
test("standalone HTML filters and drills down; injected script text stays data", (t) => {
  const { report } = setup(t, [
    scenario({
      ops: [
        {
          id: "a",
          start: 10,
          exec: 11,
          end: 50,
          cpu: 5,
          exe: "/bin/</script><script>window.INJECTED=1</script>",
        },
      ],
    }),
  ]);
  const html = renderProcessHtml([report], aggregateProcessReports([report]));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1]);
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  t.after(() => dom.window.close());
  assert.equal(dom.window.INJECTED, undefined);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".bar").length, 2);
  doc.querySelector(".bar").click();
  assert.match(doc.getElementById("detail").textContent, /raw_records/);
  doc.getElementById("search").value = "missing-executable";
  doc.getElementById("search").dispatchEvent(new dom.window.Event("input"));
  assert.equal(doc.querySelectorAll(".bar").length, 0);
  assert.match(csv([{ value: "=HYPERLINK(1)" }], ["value"]), /'=HYPERLINK/);
});
