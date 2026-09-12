# 单轮最终批次独立验收

日期：2026-09-10。独立验收者从仓库交接文档和落盘结果重新定位证据，未参与本次运行或修复。范围遵循[已确认的三项安排](../BENCHMARK_PAUSE_HANDOFF.md)：验收真实任务执行、父子协作证据、结果保存及效率观测，不以解题正确率或逐条附录措辞作为通过门槛。

**最终阶段验收与新会话交接验证 PASS，未发现阻断本次行为观测目标的数据缺口。**
本结论不表示30题均解对、所有模型执行均成功或所有任务约束均得到遵守。

本次只读审阅 JSON/JSONL、核对既有 SHA256/字节数/指纹、抽查内容并查询已结束服务的宿主终态；没有提交模型、评分、重算trace分析、重跑测试或校准、修改原批次、操作运行状态或清理资源。只读核验工具及零差异结果已保存于
`../benchmark-lab/runs/audits/final-30-completion-1789042674304/final_batch_independent_verify.{py,json}`，同目录保存宿主终态、30项CSV/JSON映射、汇总工具及完成批次文件hash，不依赖临时目录。

## 批次与来源

完成批次为 `acceptance-30-001-behavior-v3`，位于仓库外 `../benchmark-lab/runs/`。 `active.json`
指向v3，`run.json`、`progress.json`、`report.json`一致记录30项计划、30项done、无当前/下一任务。独立比对三版计划和
`tasks.json`，001-01–030-01逐项一致、任务ID唯一、每项repetition=1，没有遗漏或重复分配。

| 编号    | 最终证据原路径                            | 保留状态                       |
| ------- | ----------------------------------------- | ------------------------------ |
| 001–005 | `acceptance-30-001/attempts/`             | 原批次interrupted，005用户中断 |
| 006–016 | `acceptance-30-001-behavior-v2/attempts/` | 原批次blocked，016观察超时     |
| 017–030 | `acceptance-30-001-behavior-v3/attempts/` | 新执行14项，批次complete       |

v3本地attempt目录恰为017–030；001–016通过带SHA的原路径继承，001–005继续指向最初批次。两级continuation的8个来源锚点、21个继承attempt引用和v3来源清单的1,634份文件均与现存文件一致。没有以接续覆盖历史终态。

- 003和016仍为 `infrastructure_failure`，原 `timed out`
  保留；016的结束时间和此前独立调查记录仍在。003旧attempt没有 `executionEndedAtMs`
  字段，不能假定所有版本都有相同的runner时间字段。
- 005仍为 `interrupted`；原
  `shutdown-pause-final.json`明确记录用户关机暂停，三个最终checkpoint均为0字节。两个child已真实创建和dispatch，但在取消前没有工具调用；不能解释为完整预算下的模型失败。
- 009保留原HTTP400、`submissionRejections`、未入队的恢复前证据、原prompt
  SHA和修复版本记录。最终只有一次root模型dispatch，恢复前空 `runtime-001.jsonl` 与实际执行的
  `runtime-002.jsonl`
  及两份host附件同时保留。旧等待不能计入模型执行时间，也不能把4个容器误当4次模型提交。

模型终态逐项核对为completed20、deadline6、infrastructure_failure2、interrupted1、failed1。历史001–005保留scored5，新006–030均为
`skipped / not_scored / disabled_by_config`。机器协议仍为passed7、failed11、review_required12；这些数值不是正确率或人工通过率。

## 真实执行与产物覆盖

全量核对session树、API session-index、runtime dispatch及container归属：

- 30棵树，每棵一个root和两个直接child，共90个跨批次唯一session，没有孙级session。
- 保存92个唯一容器身份，28项各3个，009和030各4个；每个session均有自己的容器、sandbox/provider标识及与冻结任务runtime一致的image
  ID。额外容器属于同一session的生命周期记录，没有混用不同session容器。
- 100次runtime `prompt.start`，按(sessionId,
  messageId)去重仍为100，与API持久化的100条user_message事件一一对应；30次root及70次child，模型均为
  `deepseek/deepseek-v4-flash`、reasoning
  effort为空。30个root各提交执行一次；额外10次来自006、008、013、014、030的child follow-up。
- 88个session有持久化工具调用，共6,518次；其余两个是005在用户暂停前尚未开始工具调用的child。全部90个session都有runtime和host附件中的身份覆盖，但附件存在不代表连续资源观测完整。
- 90份最终checkpoint及75份最终publication引用（parent21、child54）SHA/字节数均正确；384份历史patch文件内容与文件名SHA一致。未publish的失败/中断状态如实保留，不能将checkpoint称为模型最终发布。

API的messages记录总数是101，不能与上述user_message事件或dispatch数混同。011的child
`befbaa609afe1e4b22a1b74f87987a6b`另有follow-up消息
`59d629c8233072078e4e7633c6cc5a46`，startedAt为空、最终failed，没有runtime
dispatch；只读核对该消息的最终metadata与摘要说明一致。

内容抽样覆盖004、009、017、023、030，核对实际spawn输出、child发布、parent按session/hash获取patch及最终capture。004和023可直接追到两份child补丁与parent发布；009还保留模型请求不支持的reasoning
override而被拒绝的工具输出。本次没有逐题全文评判分工质量、代码正确性、需求转达完整性或所有网络行为。

## Trace和批次分析

| 核对对象                             | 结果                    |
| ------------------------------------ | ----------------------- |
| 30份最终trace的manifest引用          | 30/30 SHA一致           |
| trace `hashes.json`列出的文件        | 722/722 SHA及字节数一致 |
| 批次collection与原trace的全部文件    | 782/782逐文件一致       |
| 30份attempt analysis的output-hashes  | 420/420一致             |
| 批次analysis的output-hashes          | 5/5一致                 |
| batch runs对原analysis summary的引用 | 30/30 SHA一致           |

`trace-batch-001/inputs.json`与计划及每个attempt最终trace路径逐项吻合，30个candidate、runId及
`runs.jsonl`行无重复或遗漏。独立依照既有算法核对30个input fingerprint、30个trust-anchor
fingerprint及batch fingerprint，全部一致，没有运行分析器。

批次指纹为
`1937acab4a6b97a6e59b8c3b1d6cd4207dee789246642dcf44f3c8a3867ec767`。manifest和aggregate均记录successfulRunCount=30、failureCount=0，`failures.jsonl`为空；这里的success表示分析成功。30份分析validation均valid、errors为空；trace拓扑父级不匹配和复合ID重复清单均为空。

`trace.complete`指可取得的API分页、拓扑和文件hash核验完成，不是逐token无损记录。既有missingness明确：step-start/finish和heartbeat不持久化，token/tool状态有upsert，OpenCode原始消息及实时SSE到达顺序未完整保存，Cloudflare
logs未附入trace。host采样有时间空档且服务器资源为共享归属；消息区间重叠不能当作CPU或shell真实并行时长。平台
`totalCost`不是可核对的供应商账单，现有记录不能给出完整token或严格费用上限。严格重复签名指标也不能直接推出可消除工作、节省比例或因果提速；本批没有消融或统计显著性结论。

## 030及协议自动检查的局限

030的root为 `2ccb5a8cb4d867ed274e5982bc66fce6`，最终如实记为modelExecution=failed。原runtime保存root
`opencode.crash`、exit_code=-9、`opencode.max_restarts`、`supervisor.fatal`
及SSE传输/最终状态读取错误；最终execution_complete为success=false、event stream
disconnected。这是观测到的运行故障；本次没有确定进程被杀的根因，也不能据此评价解题能力。

child
`e5533aee4482c261694211d5d2d5edca`的首条message同样断流失败，之后parent在同一child追加两条prompt。三个message
ID、三个dispatch、失败事件、两次后续成功事件及两个容器身份均保留；最终child
session的completed不能覆盖首message失败。parent在原attempt预算内进行了恢复和纠偏，没有新建root重跑。

其第二条message中，工具成功读取了DSPy上游
`usage_tracker.py`、`cache.py`、`prediction.py`、PR8394页面及
`.diff`。`normalized/events.jsonl`保留URL、成功工具输出和82行PR
diff；parent后续prompt明确指出错误feature并要求撤回、按原cache-statistics要求修正。这是已确认的上游读取，与原禁止访问约束不符，构成行为及可能影响结果独立性的局限；不能宣称整批完全没有外部参考污染。

该child错误发布的 `41ca5fc2…` 与后续 `f7d09860…` 补丁均仍在，parent两次fetch也在trace。最终两个child
publication有SHA引用；root仅有15,114字节最终checkpoint，未发布成功最终答复。收尾没有把这些事实改写为成功。

009/030的机器协议均包含 `Missing/distinct container identity evidence`。只读审阅
`tools/benchmark/reporting.py`确认该规则同时要求容器数量恰好等于session数量；本次已直接核对四个容器的实际归属，因此该条在这两项上包含计数规则局限，不能解释为没有独立容器。原协议结果保持原样；其余失败条目也没有因此自动豁免。

## 终态和清理

独立宿主只读查询时间为1789042586877 ms（2026-09-10 20:16:26+08）。unit为
`oi-bench-acceptance-30-001-behavior-v3-1789034824896-4ea33422.service`，
`MainPID=0 / Result=success / LoadState=loaded / ActiveState=active / SubState=exited`。这是保留退出状态的service，没有正在运行的worker。

launch的 `exit.json`记录exitCode=0、endedAtMs=1789041566335（19:59:26+08）；原worker
PID960008和最后控制平面PID1240013均不在 `/proc`。按设备号/inode核对 `/proc/locks`，coordinator和v3
batch两锁均无持有者。30份cleanup均complete、remainingContainers/errors为空；宿主Docker查询无模型容器，仅原
`oi-opensandbox-server`运行，另有三个两个月前已退出的旧容器。本次未清理这些资源。

## 新会话交接验证

**PASS。** 最终从根 `AGENTS.md` 的Further Reading入口进入
[运行手册](../BENCHMARK_RUNBOOK.md)，再进入[完成摘要](FINAL_BATCH_SUMMARY.md)、
[暂停交接](../BENCHMARK_PAUSE_HANDOFF.md)及[总进度](../BENCHMARK_EXPERIMENT_PROGRESS.md)。这五份入口文件中的40个本地文档链接均存在。

- 各入口顶部一致标记v3为complete，30/30
  done、结束时间19:59:26、无下一任务；首个运行命令仅为只读status，start/resume/准备/校准明确作为历史或未来显式任务的参考。PAUSE_HANDOFF和PROGRESS的旧“最新/运行中”段落有明确的最高优先级完成说明覆盖，RUNBOOK的旧v2/v3运行入口已标历史。
- 完成摘要直接给出report/异常索引、run/两级source-evidence、整批analysis及持久化终态审计路径。
  `attempt-overview.json`含30行及task、benchmark、evidencePath、tracePath、analysisPath，可按attempt定位原批次/v2/v3证据，无需聊天历史或重新运行report命令。
- 摘要明确5项历史评分、25项未评分，保留003/016故障、005用户中断、009拒绝恢复、030断流与确认的上游暴露、固定容器计数规则局限，以及101条message和100次dispatch的差别。耗时、成本与重复指标有口径和解释边界，没有把机器协议/分析成功当作正确率，或宣称已完成90次多轮实验。
- 持久化 `completion.json`
  的计数、unit/退出码/锁/容器终态与本次独立核查一致。后续读取只需上述入口与仓库外lab，不要求恢复模型、原终端或旧Codex会话。

本次单轮的执行证据、最终收尾、描述性结果说明及新会话定位均已交付；已知行为和观测局限继续保留，没有待修复事项被隐含列为通过条件。
