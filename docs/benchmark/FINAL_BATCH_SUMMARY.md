# 30项单轮：完成状态与行为观测概览

2026-09-11更新：四项单次补跑也已完成，详见[补跑结果](FAULT_SUPPLEMENT_RESULTS.md)。其中3项模型completed，030仍OOM失败且实际应用了参考补丁。补跑数据单列，原30项统计不变。

2026-09-11附记：用户授权另做[四项故障补跑](FAULT_SUPPLEMENT.md)。补跑使用独立批次，原30项结果与下述统计不变；新增对030原始Docker
OOM事件的诊断记录在该补跑文档中。

**批次正常完成，证据与收尾独立验收PASS。** 最终批次是 `acceptance-30-001-behavior-v3`，于
**2026-09-10 19:59:26（Asia/Shanghai）**
结束。30项均为done，没有当前阻断或下一项；runner退出码0、MainPID=0，本批控制平面/服务进程组已退出，两锁释放，无剩余模型容器。原OpenSandbox服务器继续保留。

独立验收：[FINAL_BATCH_REVIEW.md](FINAL_BATCH_REVIEW.md)。本结论表示本轮执行、采集、汇总和收尾完成；任务中的失败、中断、协议问题及实验规则违例仍保留，不能据此声称30项都解题成功或都满足实验规则。没有启动90次正式多轮实验，也没有重跑失败任务、重新评分或重算已有分析来替换结果。

## 结果分层

| 维度                        | 本轮记录                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| 计划与终态                  | FeatureBench 15项、CooperBench 15对；30/30 done                                 |
| 模型执行状态                | completed 20；deadline 6；infrastructure_failure 2；用户interrupted 1；failed 1 |
| 机器协议                    | passed 7；failed 11；review_required 12；均保留原判定                           |
| 产物、trace、逐题分析、清理 | 每个维度均30/30 complete                                                        |
| 整批分析                    | 30份输入处理成功，0份分析失败；每个attempt只纳入最终trace一次                   |
| 官方评分                    | 旧001–005共5项历史评分；006–030共25项按配置未评分；无pending                    |
| 实际规模                    | 90个独立session，92个不同容器，100条去重runtime prompt.start记录                |

API保存101条message，其中011的一条child follow-up没有startedAt，最终failed，没有对应runtime
dispatch；因此不能把message数当成实际模型调用数。005两child虽已创建并收到dispatch，但用户中断前没有工具调用。92个容器包含009拒绝前热启动及恢复后的容器，以及030同一child后续请求引发的容器重建；不是新增task。

## 必须保留的例外

- **003、016：**
  观察读取故障造成提前取消，保留infrastructure_failure；不是完整模型预算下的能力结论。016后加入有限只读重试并生成v3版本。底层本地停顿原因仍未确定。
- **005：** 用户关机中断。原空patch评分早退、实际未测试及中断原因全部保留。
- **009：**
  原77,643字符prompt在入队前因旧64,000上限被拒；零消息证据、旧意图、修复版本及第一次有效提交均保留。总分配墙钟包含排查等待，不应全部解释为模型运行时间。
- **030：**
  child与parent出现SSE断流，runtime有OpenCode进程被终止记录；failed包含运行故障，不能解释为解题能力失败。parent发送两次child
  follow-up，原失败及后续请求均留在同一attempt，未自动重跑整个任务。已由实际工具输出确认读取上游源码、PR页面及diff，违反实验的禁取上游规则；该样本须标记上游暴露，不能当作干净的独立完成样本。不能仅凭parent叙述或最终patch推断具体信息影响程度。
- **机器协议局限：**
  009、030的4容器记录触及validator的固定3容器计数规则，不能据该项机器失败认定缺少真实父子独立容器。12项review_required没有在本次逐题全文重审，不冒充语义全部通过。

这些是行为数据与有效性的边界；原始报告没有被人工改成成功。

## 已有分析的描述性概览

下表从既有逐题analysis/lifecycle读取，不重新执行模型或分析器。消息跨度为首个message开始到最后一个message结束；首child延迟为首个message开始到第一次child创建。每套均包含全部15项，包括失败与中断。

| 指标                  | FeatureBench | CooperBench |
| --------------------- | ------------ | ----------- |
| 消息跨度中位数        | 19.54分钟    | 4.44分钟    |
| 首child创建延迟中位数 | 275.07秒     | 48.22秒     |
| 已归档工具调用数      | 4,877        | 1,641       |

两套任务的规模和分工条件不同，这些差异不能归因于runner修复或某种协作策略。全批已有分析记录6,518次工具调用；平台totalCost字段合计3.8982796216，保留其原始口径，不作真实账单核对。v3新增14项的readDiagnostics没有记录读取失败或重试；修复的故障恢复验证来自受控测试，不能据本轮没有再次触发故障而断言底层停顿已消除。

整批分析按各run等权汇总，原报告的specificSiblingPresenceRatio均值约4.21%、syntacticWithinSiblingRepetitionRatio均值约25.79%，解析覆盖率均值约93.01%。这是分析器既有口径下的重复出现/解析指标，保留各run原始分子、分母（包括空分母口径）；不能换算成可节省时间、token或可删除工作比例。没有做统计显著性、因果对照或语义结果等价性推断。

“trace
complete”指当前导出契约下的分页与文件hash完整，不代表无损SSE录制：token和tool状态存在upsert，step-start/finish和heartbeat未全部持久化，模型关闭后未重新唤醒读取OpenCode原始message。资源数据是采样值，消息/工具区间重叠不等于精确CPU或shell并行。原batch分析的repository=`/`来自repo-less控制平面元数据；真实任务与仓库使用tasks.json和下述attempt概览映射。

## 从哪里继续读

仓库根目录执行 `python3 tools/benchmark/service.py status`
即可只读确认当前完成状态。无需再start/resume，也不需要安装npm。后续分析先读这些文件：

| 文件/目录（相对`../benchmark-lab/`）                                          | 用途                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `runs/acceptance-30-001-behavior-v3/report.json`、`exceptions.json`           | 全30项结果与异常索引                                    |
| `runs/acceptance-30-001-behavior-v3/run.json`、`source-evidence.json`         | 计划、两级继承、实现与来源hash                          |
| `runs/acceptance-30-001-behavior-v3/trace-batch-001/analysis/`                | 原始整批report、runs.jsonl、aggregate-summary及输出hash |
| `runs/audits/final-30-completion-1789042674304/completion.json`               | 宿主终态、运行/分析计数及汇总范围                       |
| `runs/audits/final-30-completion-1789042674304/attempt-overview.csv`、`.json` | 30项任务/路径/状态/时间/工具计数映射                    |
| `runs/audits/final-30-completion-1789042674304/`                              | 本轮汇总工具、独立核验工具与结果、完成批次文件hash      |

证据分布仍为原`acceptance-30-001`的001–005、v2的006–016、v3的017–030；最终report中的evidencePath/trace.path可直接定位，不能因接续版本把同一attempt重复计数。旧v2的blocked是保留的历史终态；当前活动批次v3为complete。
