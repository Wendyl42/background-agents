/** Standalone report: embedded evidence, per-clock timelines, no external scripts or requests. */
import { basename } from "node:path";
import { ns } from "./math.mjs";

const ms = (value) =>
  value === null || value === undefined
    ? "unavailable"
    : `${(Number(ns(value)) / 1e6).toFixed(3)} ms`;
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
const json = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

export function processMarkdown(reports, aggregate) {
  const lines = [
    "# Measured process analysis",
    "",
    "Elapsed, CPU and overlapping process coverage have separate denominators. Same-command candidates do not establish redundancy, critical-path cost or removable latency.",
    "",
    `Tasks: ${aggregate.tasks}; tasks with eligible coverage: ${aggregate.tasks_with_coverage}.`,
    `Task-equal coverage: ${aggregate.task_equal_mean_coverage ?? "unavailable"}; workload-weighted coverage: ${aggregate.workload_weighted_coverage ?? "unavailable"}.`,
    "",
  ];
  for (const report of reports) {
    lines.push(
      `## ${report.input.root_session_id}`,
      "",
      `Evidence: ${report.status}; complete transport: ${report.quality?.complete ?? "unavailable"}; analysis issues: ${report.issues.join(", ") || "none"}.`,
      ""
    );
    if (report.status === "unavailable") {
      lines.push(report.summary.reason, "");
      continue;
    }
    lines.push(
      `Exact tool p50 / p95: ${ms(report.summary.tool_elapsed.p50_ns)} / ${ms(report.summary.tool_elapsed.p95_ns)}.`,
      `Known workload self CPU: ${ms(report.summary.self_cpu.known_ns)}; missing stage counters: ${report.summary.self_cpu.missing}.`,
      `Carrier self CPU (may include builtins): ${ms(report.summary.carrier_self_cpu.known_ns)}.`,
      `Cumulative process elapsed: ${ms(report.summary.cumulative_process_elapsed.known_ns)} (overlapping durations may be added here; this is not wall time).`,
      "",
      "| Command group (includes descendant work) | Group elapsed | Self CPU total | Raw evidence |",
      "| --- | ---: | ---: | --- |"
    );
    for (const group of [...report.groups]
      .sort(
        (a, b) =>
          Number(ns(b.elapsed_ns) ?? 0n) - Number(ns(a.elapsed_ns) ?? 0n) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, 20)) {
      const ref = group.sources[0];
      lines.push(
        `| ${escape(basename(group.executable ?? "inherited image")).replace(/[\r\n|]/g, " ")} | ${ms(group.elapsed_ns)} | ${ms(group.self_cpu.total_ns)} | ${ref?.path}:${ref?.line} |`
      );
    }
    lines.push(
      "",
      "See timeline.html for process/exec drill-down and embedded source records; stages.jsonl/groups.jsonl contain all entries. Root launcher and the first carrier Bash stage are excluded from workload costs. Shell startup descendants remain visible operations. Interpreter internals and result-consumption boundaries remain unknown.",
      ""
    );
  }
  return lines.join("\n") + "\n";
}

export function renderProcessHtml(reports, aggregate) {
  const payload = {
    aggregate,
    reports: reports.map((report) => {
      const stages = report.stages.slice(0, 2000);
      const refs = new Set(
        [...stages, ...report.tools]
          .flatMap((row) => row.sources)
          .map((ref) => `${ref.path}:${ref.line}`)
      );
      return {
        ...report,
        stages,
        stage_total: report.stages.length,
        evidence: report.evidence.filter((row) =>
          refs.has(`${row.source.path}:${row.source.line}`)
        ),
      };
    }),
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Measured agent process timeline</title><style>
:root{font-family:system-ui,sans-serif;color:#172333;background:#f3f6fa}body{max-width:1500px;margin:auto;padding:24px}h1{font-size:28px;margin-bottom:8px}p{line-height:1.5}.note{background:#fff6dd;padding:12px;border-left:4px solid #b88b1a}.controls,section{background:white;border:1px solid #d6dfeb;border-radius:8px;padding:16px;margin:16px 0}.controls{display:flex;gap:16px;flex-wrap:wrap;align-items:center}select,input{padding:6px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e1e7ef}button{cursor:pointer;background:#f6f9ff;border:1px solid #b5c9e4;border-radius:4px;padding:5px 10px}.lane{display:flex;border-bottom:1px solid #eef1f5;align-items:center;min-height:29px}.label{width:330px;flex-shrink:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{position:relative;flex:1;height:26px}.bar{position:absolute;top:4px;height:18px;background:#3478c4;min-width:2px;border:0;padding:0;border-radius:3px}.bar.opaque_interpreter,.bar.inherited_image{background:#8961ad}.bar.launcher,.bar.carrier_shell{background:#98a6b6}.bar.open{background:#d6a235}.axis{font-size:12px;color:#5e7088}pre{overflow:auto;max-height:550px;background:#111e30;color:#e2edfb;padding:16px;font-size:12px}summary{cursor:pointer}small{color:#64748b}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:850px){.two{display:block}.label{width:200px}}
</style><h1>Measured agent process timeline</h1><p>Tool hooks → process instances → exec stages → disjoint command groups.</p>
<p class="note">Process lifetime is elapsed, not CPU. Intervals overlap; union is not critical path or saved latency. Root carrier/launcher stages are excluded from workload metrics. Interpreter internals, child-result availability and parent consumption are not measured. Different clock domains are displayed separately.</p>
<div class="controls"><label>Task <select id="task"></select></label><label>Session <select id="session"></select></label><label>Find <input id="search" placeholder="executable / process ID"></label><label><input type="checkbox" id="infra"> Show infrastructure</label><label>Zoom <input type="range" id="zoom" min="1" max="8" value="1"></label></div>
<section id="overview"></section><section><h2>Tool envelopes and shell coverage</h2><div id="coverage"></div></section>
<section><h2>Process / exec timeline</h2><p class="axis">Blue: external execution · Purple: interpreter/inherited image · Grey: infrastructure · Amber: missing endpoint. Click a bar for raw source evidence.</p><div style="overflow:auto" id="timeline"></div></section>
<div class="two"><section><h2>Command groups</h2><p><small>Each stage belongs to at most one group. Group CPU sums self counters once. Elapsed includes group descendants and may overlap other groups.</small></p><div id="groups"></div></section><section><h2>Sibling matching-command candidates</h2><p><small>Same executable path, complete argv, cwd and declared repository identity. Mutable input/environment equivalence is unverified. Candidate clusters can overlap; use unique-group totals.</small></p><div id="candidates"></div></section></div>
<section><h2>Coordination evidence</h2><p><small>Exact coordination tool envelopes and persisted control-plane message/request observations are separate clock domains. A status request is not proof that the parent read a result.</small></p><div id="coordination"></div></section>
<section><h2>Selected evidence</h2><pre id="detail">Select an operation. References point to hashed raw bundle files and 1-based lines.</pre></section>
<script type="application/json" id="data">${json(payload)}</script><script>
const data=JSON.parse(document.getElementById('data').textContent), task=document.getElementById('task'), session=document.getElementById('session');
const $=id=>document.getElementById(id), fmt=n=>n===null||n===undefined?'unavailable':(Number(n)/1e6).toFixed(3)+' ms';
const append=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node};
for(let i=0;i<data.reports.length;i++){const o=append(task,'option',data.reports[i].input.root_session_id);o.value=i}
function current(){return data.reports[Number(task.value)||0]}
function show(item){const r=current(),refs=item.sources||[];const evidence=r.evidence.filter(row=>refs.some(ref=>ref.path===row.source.path&&ref.line===row.source.line));$('detail').textContent=JSON.stringify({measurement:item,raw_records:evidence},null,2)}
function table(parent,headers,rows){const t=append(parent,'table',''),head=append(t,'tr','');headers.forEach(x=>append(head,'th',x));for(const row of rows){const tr=append(t,'tr','');for(const value of row){const td=append(tr,'td','');if(typeof value==='object'&&value!==null){const b=append(td,'button',value.label);b.onclick=()=>show(value.item)}else td.textContent=String(value)}}}
function resetSessions(){session.replaceChildren();const all=append(session,'option','All sessions');all.value='';for(const s of current().session_tree){const o=append(session,'option',(s.parent_id?'↳ ':'')+s.id);o.value=s.id}}
function render(){const r=current(),q=$('search').value.toLowerCase(),sid=session.value;for(const id of ['overview','coverage','timeline','groups','candidates','coordination'])$(id).replaceChildren();
append($('overview'),'p','Evidence: '+r.status+' · Transport complete: '+(r.quality?.complete??'unavailable')+' · Analysis complete: '+(r.analysis_complete??false));
append($('overview'),'p','Task-equal coverage: '+(data.aggregate.task_equal_mean_coverage??'unavailable')+' · Workload-weighted coverage: '+(data.aggregate.workload_weighted_coverage??'unavailable')+' · Eligible tasks: '+data.aggregate.tasks_with_coverage+'/'+data.aggregate.tasks);
if(r.status==='unavailable'){append($('overview'),'p',r.summary.reason);return}
append($('overview'),'p','Known workload self CPU: '+fmt(r.summary.self_cpu.known_ns)+'; '+r.summary.self_cpu.missing+' stage counters missing. Carrier CPU (may include builtins): '+fmt(r.summary.carrier_self_cpu.known_ns)+'. Exact tool p50/p95: '+fmt(r.summary.tool_elapsed.p50_ns)+' / '+fmt(r.summary.tool_elapsed.p95_ns));
append($('overview'),'p','Quality issues: '+JSON.stringify(r.quality.issues)+'; analysis issues: '+JSON.stringify(r.issues));
if(r.stage_total>r.stages.length)append($('overview'),'p','Timeline shows '+r.stages.length+' of '+r.stage_total+' stages; full data is in stages.jsonl.');
const tools=new Map(r.tools.map(t=>[t.id,t]));table($('coverage'),['Tool','Exact elapsed','Process union in tool','Uncovered tool','Uncovered carrier','Alignment uncertainty','Evidence'],r.coverage.filter(c=>!sid||c.inspect_session_id===sid).map(c=>[{label:c.tool,item:tools.get(c.span_id)||c},fmt(c.exact_tool_elapsed_ns),fmt(c.observed_process_union_ns),fmt(c.uncovered_tool_elapsed_ns),fmt(c.uncovered_carrier_elapsed_ns),fmt(c.clock_mapping_uncertainty_ns),c.complete?'complete':'incomplete / unbound']));
const rows=r.stages.filter(s=>(!sid||s.inspect_session_id===sid)&&($('infra').checked||!s.infrastructure)&&JSON.stringify([s.executable,s.process_id]).toLowerCase().includes(q));const domains=[...new Set(rows.map(s=>s.clock_id))].sort();
for(const domain of domains){const list=rows.filter(s=>s.clock_id===domain).sort((a,b)=>a.inspect_session_id.localeCompare(b.inspect_session_id)||a.process_id.localeCompare(b.process_id)||a.exec_index-b.exec_index);const values=list.flatMap(s=>[s.start_ns,s.end_ns].filter(x=>x!==null).map(BigInt));const lo=values.reduce((a,b)=>a<b?a:b),hi=values.reduce((a,b)=>a>b?a:b),extent=Number(hi-lo)||1;append($('timeline'),'h3','Clock '+domain);append($('timeline'),'p','0 → '+(extent/1e6).toFixed(3)+' ms; relative to this domain’s earliest visible stage.');const block=append($('timeline'),'div','');block.style.minWidth=(100*Number($('zoom').value))+'%';for(const s of list){const lane=append(block,'div','');lane.className='lane';const label=append(lane,'div',s.inspect_session_id+' · '+(s.executable||'unknown')+' · exec '+s.exec_index);label.className='label';label.title=s.process_id;const track=append(lane,'div','');track.className='track';const bar=append(track,'button','');bar.className='bar '+s.kind+(s.duration_ns===null?' open':'');bar.style.left=(100*Number(BigInt(s.start_ns)-lo)/extent)+'%';bar.style.width=(s.duration_ns===null ? .3 : 100*Number(BigInt(s.end_ns)-BigInt(s.start_ns))/extent)+'%';bar.title=s.kind+' · '+fmt(s.duration_ns)+' · self CPU '+fmt(s.cpu_runtime_ns);bar.onclick=()=>show(s)}}
const groups=r.groups.filter(g=>!sid||g.inspect_session_id===sid).sort((a,b)=>Number(b.elapsed_ns||0)-Number(a.elapsed_ns||0)||a.id.localeCompare(b.id));table($('groups'),['Command','Group elapsed','Self CPU','Processes'],groups.slice(0,100).map(g=>[{label:g.executable||'inherited image',item:g},fmt(g.elapsed_ns),fmt(g.self_cpu.total_ns),g.member_process_ids.length]));
table($('candidates'),['Family','Occurrences','Candidate CPU'],[...r.candidates].filter(c=>!sid||c.group_ids.some(id=>groups.some(g=>g.id===id))).sort((a,b)=>Number(b.candidate_cpu.known_ns||0)-Number(a.candidate_cpu.known_ns||0)||Number(b.candidate_elapsed.known_ns||0)-Number(a.candidate_elapsed.known_ns||0)||a.id.localeCompare(b.id)).slice(0,100).map(c=>[{label:c.kind,item:c},c.count,fmt(c.candidate_cpu.total_ns)]));
for(const key of ['spans','requests','messages']){const details=append($('coordination'),'details','');append(details,'summary',key+' ('+r.coordination[key].length+')');append(details,'pre',JSON.stringify(r.coordination[key],null,2))}
}
task.onchange=()=>{resetSessions();render()};session.onchange=render;$('search').oninput=render;$('infra').onchange=render;$('zoom').oninput=render;resetSessions();render();
</script></html>`;
}

export function csv(rows, columns) {
  const cell = (value) =>
    `"${String(value ?? "")
      .replace(/^[\s]*[=+@-]/, "'$&")
      .replace(/"/g, '""')}"`;
  return (
    [
      columns.map(cell).join(","),
      ...rows.map((row) =>
        columns
          .map((key) => cell(typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key]))
          .join(",")
      ),
    ].join("\n") + "\n"
  );
}

export { escape as escapeHtml };
