# 关机暂停交接

只需了解当前结论与重点文档时，请先看[阅读导航](benchmark/README.md)；本文件保留会话交接和历史过程。

## 2026-09-12 当前收尾范围

原30项与4项补跑均已完成并验收，本地协作数据包也已完成。用户选择将数据下载到Mac，不再发布公开Release；未上传数据，原件继续保留。包的位置、下载清单与分析入口见[阅读导航](benchmark/README.md)。Mac下载是否完成尚未核实，不自动删除服务器原件。下方接续、补跑和启动说明均为历史，不再自动执行；额外实验或研究改进另行安排。

## 2026-09-11 四项补跑已完成（最新状态）

当前活动批次 `fault-supplement-20260911-001` 于北京时间 **12:56:55** 正常结束：4/4 done，runner
exitCode=0、MainPID=0，无当前阻断/下一项，模型容器已清理，两锁释放。003-02、005-02、016-02模型执行completed；030-02仍failed，实际3840MiB下记录4次OOM，并确认取回、应用参考实现/测试补丁，参考代码流入最终产物。030不能作为干净成功样本。

四项产物/trace/分析/清理均complete，整批分析4份成功0失败；评分全部按配置跳过。原30项和原3719文件保持不变。本次补跑已达到各一次的预定范围，不自动第三次重跑。请先读[补跑结果](benchmark/FAULT_SUPPLEMENT_RESULTS.md)及
[独立补跑终验](benchmark/FAULT_SUPPLEMENT_FINAL_REVIEW.md)。原30项结论与四项补充要分开汇报。

```bash
# 只读查看已完成的当前补跑批次；无需resume
python3 tools/benchmark/service.py status
```

终态审计在
`runs/audits/fault-supplement-completion-1789106656227/`。后续若研究030，需要先诊断内存增长、改进参考访问限制及上下文保留，再另行登记实验；本次未启动额外实验。下方原运行中/启动命令保留作历史，不应自动执行。

## 2026-09-11 用户授权四项单次补跑（最新活动）

原30项单轮已经完成并验收，原结果保持不变。用户随后授权必要故障补跑，本次另建
`fault-supplement-20260911-001`，仅追加003-02、005-02、016-02、030-02各一次；原6项正常deadline及已恢复完成009不重跑，不用补跑结果替换原始失败。

030进一步核对到原Docker的两个OOM事件及3072MiB内存峰值，故仅030配置为3840MiB/sandbox，其余三项保持3072MiB。所有任务仍2CPU、原DeepSeek
Flash、原prompt/附录、1800秒时限、评分关闭。030原上游读取违规保留，若再失败或违规也不无限补跑。新补跑结果单列，不能与原30混作best-of。

代码99项测试及独立计划/分配验收PASS；四个原镜像存在，冻结环境证据复用，无重复下载/校准/构建。容量检查可用14062MiB、要求13568MiB，已通过。原3719个文件hash全同。独立runner已启动，unit为
`oi-bench-fault-supplement-20260911-001-1789098604386-afdf309f.service`，PID17537。完成一次启动交接后Codex结束本轮，补跑complete或blocked后再分析并独立验收。

当前status显示的是这4项补充实验；原30项仍在 `acceptance-30-001-behavior-v3`，保持complete：

```bash
python3 tools/benchmark/service.py status
```

计划、OOM新证据及停止/接续入口见[故障补跑记录](benchmark/FAULT_SUPPLEMENT.md)，独立验收见[FAULT_SUPPLEMENT_REVIEW.md](benchmark/FAULT_SUPPLEMENT_REVIEW.md)。原始审计和选择清单在
`runs/audits/fault-supplement-plan-1789098204123/`。补跑进行期间保留相关镜像；本次没有清理磁盘。

## 2026-09-10 全批已正常完成（最高优先级）

当前活动批次 `acceptance-30-001-behavior-v3` 于北京时间 **2026-09-10 19:59:26** 正常结束：30/30
done，runner
exitCode=0、MainPID=0，无当前blocked/下一项，两锁释放，无模型容器。全部30项的产物、trace、逐题分析及清理完成；整批分析30份成功、0失败。原服务器保留。

请先读[完成状态与行为观测概览](benchmark/FINAL_BATCH_SUMMARY.md)及
[最终独立验收](benchmark/FINAL_BATCH_REVIEW.md)。正常完成表示执行/证据/收尾完成，不代表所有任务解对或满足实验规则：20项模型completed、6项deadline、2项基础设施中断、005用户中断、030运行失败及确认的上游读取均保留。旧5项评分保留，新25项按配置未评分。

现在只读查看，无需重新准备、校准、评分、start或resume：

```bash
python3 tools/benchmark/service.py status
```

最终审计与CSV概览在 `runs/audits/final-30-completion-1789042674304/`；整批分析在
`runs/acceptance-30-001-behavior-v3/trace-batch-001/analysis/`。数据沿原批次/v2/v3保留，原失败不覆盖；旧v2的blocked属于历史，当前v3是complete。本次没有开始90次正式多轮实验。下一步如继续研究，使用上述摘要/异常索引按需读详细trace，不自动执行历史恢复命令或重跑任务。根AGENTS已加入运行手册入口。

下方保留的运行中/暂停/最新说明均为历史，当前状态以上述完成记录为准。

## 2026-09-10 016观察超时已处理，v3运行中（最新）

旧 `acceptance-30-001-behavior-v2`
因016状态读取超时保留为blocked历史。016在模型执行约184秒后被runner取消，产物/trace/分析/清理完整，原infra_failure保留且不重跑。已加入有限GET重试、原deadline/停止约束和逐请求诊断；POST始终只提交一次。89项测试、独立代码/分配/启动验收均PASS。日志提示本地D1及主机短暂停顿，但底层原因尚未确定。

当前运行批次是
`acceptance-30-001-behavior-v3`，通过两级SHA引用继承001–016，仅接续017–030共14项。只改变suite与runner实现版本，模型、预算、评分关闭、原题、镜像及既有环境证据均复用。启动核对时017
GoChi已进入observing，root为 `4eb7b9843e10fc250e497b188ca4393b`，有效消息1条，create和prompt
POST各1次，预算仍1800秒。原1642文件hash全同。

当前unit为
`oi-bench-acceptance-30-001-behavior-v3-1789034824896-4ea33422.service`，PID960008/PPID717、独立service
cgroup。一次启动证据在新run/startup-handoff.json及
`runs/audits/observation-timeout-016-1789033865807/restart-handoff.json`。这是启动快照；之后Codex结束本轮，不持续守候。

查看当前批次不依赖npm，也不必记住版本号：

```bash
python3 tools/benchmark/service.py status
```

旧v2的blocked不代表当前v3；当前批次complete或新的blocked后再分析/排查并独立验收。详见[016观察超时与v3接续](benchmark/OBSERVATION_TIMEOUT_V3.md)及
[独立验收](benchmark/OBSERVATION_TIMEOUT_V3_REVIEW.md)。

## 2026-09-10 009提交阻断已修复（最新）

009
Pytest首次提交77,643字符，超过原API64,000上限，在入队前被HTTP400拒绝；该次没有执行模型。已将API和内部队列上限统一为128,000，保留完整原文和Web原上限。85项针对测试、类型检查及独立恢复验收PASS。

独立runner已接续同一批次
`acceptance-30-001-behavior-v2`。启动核对时009同一root已进入observing，API恰好一条原文SHA一致的有效消息，状态processing；模型执行预算仍为正常1,800秒，官方评分仍关闭。001–008没有重跑，688份受保护文件hash无变化。原400、prompt_intent和旧时限已完整归档，控制平面修订
`prompt-api-128k-001`
从009起有独立版本记录。009总分配墙钟包含本次排查等待，不能把该等待算作模型执行。

当前unit为
`oi-bench-acceptance-30-001-behavior-v2-1789019014868-22a22eb1.service`，PID300268、PPID717，独立service
cgroup。一次启动核对证据：
`runs/audits/prompt-length-block-1789018224918/restart-handoff.json`。这些是启动快照，之后Codex结束本轮不守候。状态仍用
`python3 tools/benchmark/service.py status --run-id acceptance-30-001-behavior-v2`；complete或新的blocked后再分析/排查并独立验收。详见[长提示阻断与恢复记录](benchmark/PROMPT_LENGTH_RECOVERY.md)及
[独立验收](benchmark/PROMPT_LENGTH_RECOVERY_REVIEW.md)。

## 2026-09-10 接续实施状态（优先于下方历史说明）

已按最新三项安排完成实现及独立阶段验收
**PASS**；**独立runner已启动，Codex在完成启动交接后结束本轮，不持续盯守。**旧 `acceptance-30-001`
继续保持原 `interrupted` 状态，001–005和所有历史评分/trace不改写。新增配置
`experiments/behavior-30-v2.json`，`officialScoring=false`；新接续批次为
`acceptance-30-001-behavior-v2`，引用原5项证据，保留30项总计划和编号，仅执行006–030。新冻结记录从旧环境锁派生，只重新记录评分政策和suite版本，不重新校准或构建。

必要验证：benchmark测试 **71
passed**、修改文件ruff通过；原18个关键配置/冻结/状态/报告/关机记录SHA核对全部不变。无模型systemd探针已证明启动命令退出后独立service继续落盘并正常退出；证据持久保存于
`runs/audits/continuation-v2-implementation-20260910/`，不依赖
`/tmp`。本次验收记录见[接续修改阶段验收](benchmark/CONTINUATION_V2_REVIEW.md)。

宿主已确认原两锁释放、OpenSandbox服务停止；原模型代理 `127.0.0.1:7890`
未监听，已通知用户恢复。独立服务会复用或恢复原OpenSandbox容器、按需管理17890
relay与本批控制平面。启动、状态查看、安全停止及接续命令见[运行手册顶部](BENCHMARK_RUNBOOK.md)。启动交接已完成：systemd
unit `oi-bench-acceptance-30-001-behavior-v2-1789013087330-6a5d47e0.service`，worker
PID21900、PPID717，独立service cgroup；批次为running，006 Sympy Puiseux已提交并进入observing，root
session为 `45d9c282f0ae0c887b325febb47f239d`。只做了一次启动交接核对，记录在新批次
`startup-handoff.json`；这些是启动时快照，后续状态以落盘进度为准。

之后不持续轮询日志、不派agent盯守；整批完成或出现阻断再做分析及一次独立阶段验收。在独立宿主终端使用
`python3 tools/benchmark/service.py status --run-id acceptance-30-001-behavior-v2`
查看状态；需要时使用 `bench:stop` 安全停止，使用 `bench:service-resume`
接续，均带相同run-id。保持主机运行及系统登录会话（当前Linger=no）；不依赖Codex会话存活。最终批次验收、新会话结果交接验证和根AGENTS运行手册入口仍待整批结束，不提前宣告完成。

下方“尚未实现”“仍暂停”等说明是此前暂停时的原始历史，以上述实施状态及落盘证据为准。

## 2026-09-10 已确认的接续安排（最高优先级）

用户已同意以下三项安排，以减少Codex额度消耗。本会话仅更新交接文档，实验继续暂停；新session收到继续工作的指令后按此执行，无需重新询问是否采用这三项安排。

1. **先完成剩余修改和一次阶段独立验收。**
   将官方评分改为可选、默认跳过，明确未评分状态，并完成旧冻结批次的版本记录和接续处理；保留旧配置、已有结果与005用户中断记录。只做必要验证，不重复全30题环境校准。修改阶段完成后，由一个独立sub-agent验收并给出明确反馈；验收者不负责修复。
2. **把长时间运行交给独立终端中的runner。**
   交付与最终实现一致、可直接执行的启动、状态查看、停止和接续命令，日志与进度持续落盘；确认启动方式不依赖Codex会话存活。runner自动调度剩余25项、采集trace和收尾。启动后Codex结束当前轮次，不持续轮询、读日志或派agent盯守；不要仅把Codex工具中的后台进程视为已完成独立运行交接。
3. **整批结束或出现阻断问题后，再调用Codex。**
   先读批次摘要和异常索引，详细日志按需读取；阶段结束后再由一个独立sub-agent验收。保留每阶段独立验收要求，不把每个任务或每次状态轮询都升级为完整人工审阅。验收关注真实任务执行、父子协作、证据完整性和效率观测，不以解题正确率为主要目标。

额度边界：当前实验父、子agent配置为`deepseek/deepseek-v4-flash`，调用对应模型API；Python
runner、Docker、trace采集和官方测试程序本身不调用Codex。Codex实现、排障、分析及验收sub-agent仍消耗Codex额度。此前估计的6–10小时是剩余实验运行时间，不是Codex必须持续工作的时长，也不是额度承诺；当前只有墙钟限制，没有严格token/费用上限。独立运行期间若没有Codex调用，就不会因runner继续运行而产生Codex模型用量。

新session可使用的指令：

> 请阅读docs/BENCHMARK_PAUSE_HANDOFF.md，按最新确认的三项安排继续：先完成必要修改和一次独立阶段验收，再交付独立终端运行命令及落盘进度。启动实验后结束Codex当前轮次，不持续盯守；整批结束或出现阻断问题后再分析和验收。保留已有修改、冻结记录和结果。

## 2026-09-10 用户目标澄清（优先阅读）

用户关心在真实benchmark工作负载上采集agent行为、分析和优化效率，不以评估agent解题能力为主要目标。后续不应把官方正确率评分或严格的附录措辞验收作为主要工作；保留真实任务环境、实际父子sandbox、分工/工具/产物交互、完整trace、耗时、模型用量及可获得的资源观测。环境基本有效性仍需保证，已有校准和评分证据保留，不必重复。

**实验仍暂停。本轮仅更新交接文档，没有恢复运行或清理磁盘。**
下次继续实施时，先把官方评分改为可选、默认跳过，并让报告明确区分“按配置未评分”和“评分失败”；再处理与原冻结批次的接续及版本记录，不能覆盖旧结果或直接修改冻结文件。当前代码的`assess_attempt()`仍强制评分，尚无关闭开关，**不要直接执行下文旧的resume命令并假定评分已关闭**。

磁盘实测（2026-09-10，只读）：Docker镜像约822.1 GB；外部下载/构建缓存约98.4 GB（其中OCI压缩层约97.7
GB）；任务工作区归档约2.31 GB；运行结果/校准/审计约2.41 GB；源码和数据合计约83 MB。BuildKit显示217.5
GB，但大量与镜像共享，不能再累加。主要空间属于可重新下载或重建的环境材料；后续按当前任务镜像引用区分保留、淘汰镜像与缓存，不按Docker的“可回收”标签直接删除。版本锁、任务清单、实现、trace和结果优先长期保存。

## 暂停时的原始状态

2026-09-09
21:44（Asia/Shanghai）。用户要求关机前安全暂停，暂停已独立验收PASS。**等待用户下一条消息，勿自动继续运行。**

- 工作区修改全部保留，分支 `dev_opensandbox`，未提交或推送。数据、镜像准备材料和运行结果在仓库外
  `../benchmark-lab/`。
- 两套 benchmark 各15题已下载、固定版本，全部30题官方 baseline/gold、最终运行镜像重放及实际用户环境检查已独立验收PASS，套件已冻结。
- 两题真实试跑 `pilot-pair-001` 和单独的 runner 恢复试验 `recovery-dirty-001`
  已完成并独立验收；保留原模型失败。
- 正常单轮 `acceptance-30-001` 已安全停为 `interrupted`：001–004运行结束；005
  Pandas因本次用户关机请求中断并完成收尾。五个attempt的产物采集、trace、分析和清理均完整；001–004终态证据已独立验收。Metaflow官方通过；Packaging空patch、MLflow测试失败、Meson观察GET超时均如实保留。
- 005三份最终checkpoint均为空，官方以 `Empty patch`
  提前拒绝，测试未执行。这是用户中断，不能解释成完整模型预算下的解题失败。未创建006。
- runner及本批独立控制平面已退出，两锁释放。原OpenSandbox服务和开发实例未作全局清理。暂停信号、原PID/birth及最终状态见
  `runs/acceptance-30-001/shutdown-pause-{request,final}.json`。

## 恢复服务与历史命令（先完成上述修改和验收）

以下是原冻结版本的服务恢复信息和命令参考，不是新session的第一步。评分开关和接续版本处理尚未实现；阶段1完成后须更新实际启动命令，并按已确认安排交给独立终端运行。

1. 阅读[当前进度](BENCHMARK_EXPERIMENT_PROGRESS.md)、[运行手册](BENCHMARK_RUNBOOK.md)及[单轮独立验收](benchmark/ACCEPTANCE_30_REVIEW.md)，保留现有工作区和冻结文件，不重新下载、校准或冻结。
2. 恢复Docker及已有服务：未运行时执行
   `docker start oi-opensandbox-server`。本机模型访问依赖原宿主代理
   `127.0.0.1:7890`；恢复它后，在单独终端保持 relay：

   ```bash
   python3 packages/opensandbox-infra/proxy.py --upstream http://127.0.0.1:7890 --port 17890
   ```

3. 下列为原版本检查和resume命令。按运行手册核对宿主两锁没有新runner占用；新实现须先明确如何保留原批次并记录接续版本，不能直接运行旧命令假定评分已关闭。runner会自动启动本批控制平面，不需要另起8788实例。

   ```bash
   export PATH="$PWD/.cache/opensandbox/node/bin:$PATH"
   export BENCHMARK_LAB_ROOT="$(dirname "$PWD")/benchmark-lab"
   npm run bench:status
   npm run bench:doctor
   npm run bench:resume -- --run-id acceptance-30-001
   ```

接续跳过已收尾的001–005，从006 Sympy
Puiseux（`sympy__sympy.c1097516.test_puiseux.cd575f09.lv1`）开始，剩余10个FeatureBench任务及15个CooperBench
pair。当前backend不能恢复已关闭的005模型上下文；如后来需要补跑，只能另建尝试并保留本次中断，不能覆盖或自动重跑直到成功。

尚未完成：余下25项运行及独立验收、整批trace汇总和结果说明、最终新会话交接验证，以及完成后为根
`AGENTS.md` 增加运行手册入口。未启动90次正式多轮实验。

已知边界：003曾发生一次观察GET超时，间隙模型事件仍持续，底层原因未定；原冻结运行版本未热改，再次出现时应升级调查。机器协议
`passed`
不等于完整附录人工通过；已审阅任务中存在child指令转达遗漏，报告分别记录真实模型配置、产物链和人工结论。

关机持久备份位于
`runs/audits/shutdown-pause-20260909T134114Z/`，包含工作区修改副本、差异、临时验收工具与报告及SHA清单。当前只读审计工具SHA为
`049ec8798f4b9cd64451fcdc0a6515a3962ee4383d791e5ff2f32033582341b1`；重启后不要依赖仍存在于 `/tmp`。
