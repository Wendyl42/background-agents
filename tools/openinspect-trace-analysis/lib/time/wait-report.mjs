import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson, stableJsonl } from "../json.mjs";
import { csv } from "./report.mjs";
import { WAIT_STATES } from "./wait-timeline.mjs";

export const WAIT_STATE_LABELS = {
  child_work_pending: "至少一个子任务待处理（含排队）",
  all_final_completed: "全部已观测子任务最终轮次完成",
  all_current_completed: "全部当前轮次完成（未满足最终完成条件）",
  all_current_terminal_with_failure: "全部当前轮次结束，含失败/取消",
  unknown_child_state: "子任务状态不明",
  no_child_created: "尚无子任务创建",
  outside_parent_execution: "不在可验证的父消息执行区间",
};
const s = (ms) => (ms / 1000).toFixed(3);
const pct = (v) => (v === null ? "unknown" : `${(v * 100).toFixed(2)}%`);

export function renderWaitTimeline(data) {
  const safeJson = JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>父任务等待与子任务时间线</title>
<style>
body{font:15px system-ui,sans-serif;margin:28px;background:#f5f7fa;color:#17212b}main{max-width:1280px;margin:auto}
h1{font-size:25px}p{line-height:1.6}.panel{background:white;border:1px solid #dae1e8;border-radius:9px;padding:18px;margin:16px 0}
select{padding:8px;max-width:100%}label{margin-right:16px}svg{width:100%;min-width:820px}#chart{overflow:auto}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px}.swatch{display:inline-block;width:12px;height:12px;margin-right:5px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px;text-align:left;border-bottom:1px solid #e4e8ec}
td.path{overflow-wrap:anywhere}button{cursor:pointer;padding:5px 9px}.muted{color:#526575;font-size:13px}
</style><main><h1>父任务等待与子任务时间线</h1>
<p>只分析父 agent 的显式等待调用。绿色/紫色表示等待期间全部当前子任务消息已完成；这不是经验证可节省的时间。时间为跨时钟观测代理，子任务完成不证明产出已可集成。</p>
<div class="panel"><label>任务 <select id="task"></select></label><label><input id="focus" type="checkbox">聚焦完成后的等待</label><p id="summary"></p><div id="legend" class="legend"></div></div>
<div class="panel"><div id="chart"></div><p class="muted">横轴：相对父 session 创建时间（秒）。消息条：浅灰排队、灰蓝执行；红点为 ready 事件（包括可能的重启），黄点为 get-child-status 查询。悬停查看消息/事件 ID，查询标记不表示已知其返回状态。</p></div>
<div class="panel"><h2>完成后等待的调用证据</h2><p id="empty"></p><table><thead><tr><th>调用开始（秒）</th><th>完成后重叠（秒）</th><th>其中最终轮次后（秒）</th><th>源事件位置</th></tr></thead><tbody id="evidence"></tbody></table></div>
<script id="data" type="application/json">${safeJson}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent);
const colors={child_work_pending:'#508cc7',all_final_completed:'#7759b5',all_current_completed:'#289778',all_current_terminal_with_failure:'#d59a3a',unknown_child_state:'#8c939a',no_child_created:'#bdc3c9',outside_parent_execution:'#db6262'};
const el=id=>document.getElementById(id),fmt=x=>(x/1000).toFixed(3);
const ns='http://www.w3.org/2000/svg';
function svgNode(tag,attrs={},text){const n=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));if(text!==undefined)n.textContent=text;return n}
for(const [key,label] of Object.entries(data.labels)){const span=document.createElement('span');const sw=document.createElement('i');sw.className='swatch';sw.style.background=colors[key];span.append(sw,document.createTextNode(label));el('legend').append(span)}
for(const a of data.attempts){const o=document.createElement('option');o.value=a.context.attemptId;o.textContent=a.context.attemptId+' · '+a.context.benchmark+' · 完成后 '+fmt(a.summary.allCompletedOverlapMs)+' s';el('task').append(o)}
const first=data.attempts.find(a=>a.summary.allCompletedOverlapMs>0);if(first)el('task').value=first.context.attemptId;
function draw(){
 const a=data.attempts.find(a=>a.context.attemptId===el('task').value);if(!a){el('summary').textContent='没有可用的 attempt';return}
 const root=a.sessions.find(x=>x.parentSessionId===null),base=root.createdAtMs;
 const allTimes=a.sessions.flatMap(x=>[x.createdAtMs,...x.messages.flatMap(m=>[m.createdAtMs,m.startedAtMs,m.completedAtMs]),...x.readyEvents.map(e=>e.atMs)]).concat(a.segments.flatMap(x=>[x.startMs,x.endMs])).filter(x=>Number.isFinite(x));
 let lo=Math.min(...allTimes),hi=Math.max(...allTimes);const completed=a.segments.filter(x=>x.state==='all_final_completed'||x.state==='all_current_completed');
 if(el('focus').checked&&completed.length){lo=Math.min(...completed.map(x=>x.startMs))-3000;hi=Math.max(...completed.map(x=>x.endMs))+3000}
 if(hi<=lo)hi=lo+1;
 el('summary').textContent=a.context.taskId+' ｜ 显式等待 '+a.summary.measurableWaitCount+'/'+a.summary.explicitWaitCount+' 次可计时 ｜ 等待并集 '+fmt(a.summary.waitUnionMs)+' s ｜ 全部当前完成后 '+fmt(a.summary.allCompletedOverlapMs)+' s ｜ 最终轮次后 '+fmt(a.summary.byStateMs.all_final_completed)+' s';
 const width=1200,left=220,plot=950,rowHeight=43,svg=svgNode('svg',{viewBox:'0 0 '+width+' '+(100+(a.sessions.length+1)*rowHeight),role:'img','aria-label':'任务等待时间线'});
 const x=t=>left+(t-lo)/(hi-lo)*plot;
 function bar(start,end,y,color,title){if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end<=lo||start>=hi)return;const r=svgNode('rect',{x:x(Math.max(lo,start)),y,width:Math.max(1,x(Math.min(hi,end))-x(Math.max(lo,start))),height:19,fill:color,rx:2});r.append(svgNode('title',{},title));svg.append(r)}
 function dot(at,y,color,title){if(at<lo||at>hi)return;const d=svgNode('circle',{cx:x(at),cy:y,r:3,fill:color});d.append(svgNode('title',{},title));svg.append(d)}
 for(let i=0;i<=6;i++){const t=lo+(hi-lo)*i/6;svg.append(svgNode('text',{x:x(t),y:21,'font-size':11,'text-anchor':'middle'},((t-base)/1000).toFixed(1)));svg.append(svgNode('line',{x1:x(t),x2:x(t),y1:30,y2:70+(a.sessions.length+1)*rowHeight,stroke:'#e4e8ec'}))}
 a.sessions.forEach((session,i)=>{const y=43+i*rowHeight;svg.append(svgNode('text',{x:0,y:y+14,'font-size':12},(session.parentSessionId===null?'父 ':'子 ')+session.sessionId.slice(0,12)+' · '+session.finalStatus));
 for(const m of session.messages){const end=m.completedAtMs??hi,start=m.startedAtMs??end;bar(m.createdAtMs,start,y,'#dce2e7','排队 '+m.messageId);bar(start,end,y,m.status==='failed'||m.status==='cancelled'?'#cfa68b':'#8fa8ba',m.status+' '+m.messageId+'; '+fmt(end-start)+' s')}
 for(const e of session.readyEvents)dot(e.atMs,y+24,'#cf4242','ready '+e.eventId);for(const e of session.statusProbes)dot(e.atMs,y+25,'#c39000','状态查询 '+(e.childId??'all')+'; '+(e.source?.eventId??''))});
 const y=43+a.sessions.length*rowHeight;svg.append(svgNode('text',{x:0,y:y+14,'font-size':12},'父任务显式等待'));
 for(const seg of a.segments)bar(seg.startMs,seg.endMs,y,colors[seg.state],data.labels[seg.state]+'; '+fmt(seg.durationMs)+' s; '+seg.invocationId);
 el('chart').replaceChildren(svg);el('evidence').replaceChildren();const candidates=a.waits.filter(w=>w.candidate).sort((a,b)=>b.allCompletedOverlapMs-a.allCompletedOverlapMs);el('empty').textContent=candidates.length?'每行保留完整调用的源位置；重叠量不是 sleep 子命令的独立耗时。':'本任务没有观察到全部当前子任务完成后的可计时显式等待。';
 for(const w of candidates){const tr=document.createElement('tr');for(const value of [fmt(w.startedAtMs-base),fmt(w.allCompletedOverlapMs),fmt(w.byStateMs.all_final_completed),w.source.file+':'+w.source.line+' · '+w.source.eventId]){const td=document.createElement('td');td.textContent=value;td.className='path';tr.append(td)}el('evidence').append(tr)}
}
el('task').addEventListener('change',draw);el('focus').addEventListener('change',draw);draw();
</script></main></html>\n`;
}

export function writeWaitReport(output, analyses, summary) {
  const waits = analyses.flatMap((a) => a.waits);
  const segments = analyses.flatMap((a) => a.segments);
  const candidates = waits
    .filter((w) => w.candidate)
    .sort(
      (a, b) =>
        b.allCompletedOverlapMs - a.allCompletedOverlapMs ||
        a.invocationId.localeCompare(b.invocationId)
    );
  const timeline = {
    version: summary.analysisVersion,
    labels: WAIT_STATE_LABELS,
    attempts: analyses,
  };
  const taskRows = summary.attempts.map((a) => ({
    attemptId: a.attemptId,
    taskId: a.taskId,
    benchmark: a.benchmark,
    disposition: a.disposition,
    explicitWaitCount: a.explicitWaitCount ?? null,
    measurableWaitCount: a.measurableWaitCount ?? null,
    unknownWaitTimingCount: a.unknownWaitTimingCount ?? null,
    waitUnionMs: a.waitUnionMs ?? null,
    allCompletedOverlapMs: a.allCompletedOverlapMs ?? null,
    allCompletedWaitShare: a.allCompletedWaitShare ?? null,
    ...Object.fromEntries(WAIT_STATES.map((state) => [`${state}Ms`, a.byStateMs?.[state] ?? null])),
    error: a.error ?? null,
  }));
  writeFileSync(join(output, "wait-summary.json"), stableJson(summary));
  writeFileSync(join(output, "wait-invocations.jsonl"), stableJsonl(waits));
  writeFileSync(join(output, "wait-segments.jsonl"), stableJsonl(segments));
  writeFileSync(join(output, "wait-candidates.jsonl"), stableJsonl(candidates));
  writeFileSync(join(output, "wait-timeline.json"), stableJson(timeline));
  writeFileSync(join(output, "wait-by-task.csv"), csv(taskRows));
  writeFileSync(join(output, "wait-timeline.html"), renderWaitTimeline(timeline));
  const o = summary.overall;
  const lines = [
    "# 父任务显式等待分析（T3 最小版）",
    "",
    `分析版本：${summary.analysisVersion}。`,
    "",
    `计划 ${summary.plannedAttemptCount} 个 attempt；纳入 ${o.attemptCount} 个；排除 ${summary.excludedAttemptCount} 个。`,
    `显式等待 ${o.explicitWaitCount} 次，其中 ${o.measurableWaitCount} 次可计时，${o.unknownWaitTimingCount} 次未知。另有 ${o.mixedCallsTaggedWaitCount} 次混合调用带等待标签，不在本次计时范围内。`,
    "",
    `累计可计时等待调用 ${s(o.cumulativeWaitCallMs)} 秒；按父 session 合并重叠后 ${s(o.waitUnionMs)} 秒。`,
    `观察到全部当前子任务完成后的等待重叠 ${s(o.allCompletedOverlapMs)} 秒，占等待并集 ${pct(o.pooledAllCompletedWaitShare)}，分布于 ${o.candidateWaitCount} 次调用、${o.candidateAttemptCount} 个 attempt。`,
    "",
    "## 等待期间的子任务状态",
    "",
    "| 状态 | 并集秒数 | 等待并集占比 |",
    "| --- | ---: | ---: |",
    ...WAIT_STATES.map(
      (state) =>
        `| ${WAIT_STATE_LABELS[state]} | ${s(o.byStateMs[state])} | ${pct(o.waitUnionMs ? o.byStateMs[state] / o.waitUnionMs : null)} |`
    ),
    "",
    "## Benchmark 对比",
    "",
    "| Benchmark | 可计时等待 task 数 | 等待并集秒数 | 完成后重叠秒数 | 累计份额 | 等权 task 平均份额 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.byBenchmark.map(
      (b) =>
        `| ${b.benchmark} | ${b.measurableWaitTaskCount} | ${s(b.waitUnionMs)} | ${s(b.allCompletedOverlapMs)} | ${pct(b.pooledAllCompletedWaitShare)} | ${pct(b.macroTaskAllCompletedWaitShare)} |`
    ),
    "",
    "没有可计时等待的 task 不进入份额均值，但保留在 wait-by-task.csv 中。重复 attempt 先在 task 内平均。",
    "",
    "## 完成边界的敏感性场景",
    "",
    "| 将子任务完成边界推迟（毫秒） | 全部当前完成后重叠（秒） | 其中最终轮次后（秒） |",
    "| ---: | ---: | ---: |",
    ...o.completionGuardScenarios.map(
      (g) => `| ${g.guardMs} | ${s(g.allCompletedOverlapMs)} | ${s(g.allFinalCompletedOverlapMs)} |`
    ),
    "",
    "这些是人为设置的边界偏移场景，不是时钟误差的置信区间或上下界。",
    "",
    "## 候选调用",
    "",
    "| Attempt | 当前完成后重叠秒数 | 其中最终轮次后秒数 | 源位置 |",
    "| --- | ---: | ---: | --- |",
    ...candidates
      .slice(0, 15)
      .map(
        (w) =>
          `| ${w.attemptId} | ${s(w.allCompletedOverlapMs)} | ${s(w.byStateMs.all_final_completed)} | events.jsonl:${w.source.line} |`
      ),
    "",
    "完整路径、事件 ID 和各子任务消息证据见 wait-candidates.jsonl / wait-segments.jsonl。",
    "",
    "## 口径与边界",
    "",
    "- 对齐父任务 explicit_wait 整次工具调用与当时已经创建的直接子 session。混合调用里的 sleep 没有独立计时，因此不计入。",
    "- 从 message.createdAt 到 completedAt 视为待处理（含排队）；所有已提交消息结束后才判定当前轮次完成。失败/取消单列；未知/缺失历史不算完成。",
    "- 最终轮次完成还要求导出中全部直接子任务已经创建、没有后续消息/ready，且最终 session 状态为 completed。其余完成区间可能位于重试、下一轮 prompt 或后续创建之前。",
    "- ready 发生于上次消息结束之后且没有新请求时，状态回退为未知；消息跨重启但未结束时持续计入待处理。ready 本身不证明发生了重启。",
    "- 工具区间仍是跨时钟代理。父消息执行窗口外的片段单列，非正时间/非终态调用不补造时长。",
    "- 只判定直接子消息状态，不推断依赖、模型是否已获知完成、后台进程是否停止或产出是否已就绪；存在嵌套子任务时不等价于整个子树完成。",
    "- 完成后重叠是调查候选，不是经验证可消除时间。资源归因、CPU/内存/I/O 和因果收益不在本次范围。",
    "",
    "打开 [交互时间线](wait-timeline.html) 选择 task，悬停查看事件，并可聚焦完成后的等待。全部图表数据随 HTML 内嵌，无外部请求。",
    "",
  ];
  writeFileSync(join(output, "wait-report.md"), lines.join("\n"));
}
