# 新会话定位与接续独立验收

验收时间：2026-09-09 10:38–10:43 UTC（北京时间 18:38–18:43）。H1 复验时间：2026-09-09 10:46–10:47
UTC（北京时间 18:46–18:47）。验收方独立从根
`AGENTS.md`、`BENCHMARK_RUNBOOK.md`、总进度、其链接的阶段验收、 `experiments/`
和外部落盘状态定位批次，没有向实施方索要运行细节。

**当前结论：PASS，H1 经独立实测复验关闭。**
冻结状态、实际批次定位、公开状态/ 预检/汇总入口及当前运行中 runner 的判断入口均通过。当前 runner 仍持有两锁，修订手册明确要求只观察；原 runner 退出且宿主确认两锁释放后才接续原 run-id。首次 FAIL/H1 与证据保留如下。本报告不验收真实模型试跑的最终结果或 30 题单轮实验。

## 已实际核对

- 按手册设置仓库内 Node PATH 和兄弟目录 `BENCHMARK_LAB_ROOT` 后，实际执行
  `npm run bench:status`：`frozen=true`、`activeBatch.runId=pilot-pair-001`；selected、officialPassed、overlayPassed、prepared、runtimeBuilt、agentEnvironmentPassed 六项计数均为 30。
- 初读 `runs/preparation-status.json`
  仍为旧快照（`frozen=false`、`activeBatch=null`），不能当作实时结论。上述公开 status 按设计刷新了该外部快照，这是本次获准的状态入口副作用；未重新准备、校准或冻结。
- `experiments/pilot-30.lock.json` SHA256 为
  `480cba951b605b6e8b483e1424c761c6f202f7b012314bda92be17153e54d0b9`，包含 30 个任务。配置、附录、两份清单、两份 benchmark 版本锁及批次中的相应副本均与冻结 hash 匹配。逐题 prepared/runtime/official/overlay/agent 共
  **150 份** 外部证据文件的 SHA 全部匹配；本次只读校验，没有重跑其评分或用户环境检查。
- 当前配置明确
  `deepseek/deepseek-v4-flash`、一次尝试、题目并发 1、两个 children、深度 1、`runtimeMaxRestarts=0`；setup/execution/TTL 分别为 600/1800/2400 秒。没有已实施的严格 token/费用上限。配置记录不证明服务端已完成模型执行。
- `runs/active.json` 唯一指向 `runs/pilot-pair-001/`。`run.json` 计划为 Packaging `001-01`
  与 dirty-equals `002-01` 各一次，符合手册试跑命令；不是无模型 warm 批次。读取时批次
  `status=allocated`，不能只据该字段推断尚未启动。
- 实际 `npm run bench:doctor` 退出 0，8 项预检通过，包括 Node v22.23.2、Docker
  29.5.3、现有私有配置、已认证 sandbox API HTTP 200 和容量；未请求模型生成。
- 实际 `npm run bench:report -- --run-id pilot-pair-001` 退出 0，只汇总并刷新外部
  `report.json`/`report.md`：计划分母 2，`observing=1`、`not_started=1`；两题均 unscored，traceBatchAnalysis 为 null。Packaging 的 modelExecution、childProtocol、benchmarkCorrectness、trace 仍 pending。没有把排队/观察状态当作模型协议通过。

## 当前 runner 的宿主证据

2026-09-09 10:41:57 UTC 读取宿主 `/proc`，10:43:32 UTC 再核对启动身份：

| 对象             | 只读实测                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runner           | PID `629226`，comm `python3`，startTicks `3283322`，宿主启动时间 `2026-09-09 18:32:37 +08:00`                                                                                     |
| runner 命令      | `python3 tools/benchmark/cli.py run --run-id pilot-pair-001 --task-id pypa__packaging.013f3b03.test_metadata.e00b5801.lv1 --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3` |
| runner cwd       | `/home/liuyihua/Dev/RA-Agent/background-agents`                                                                                                                                   |
| coordinator lock | `runs/coordinator.lock` 保存 PID `629226`、acquiredAtMs `1788949958150`；设备/inode `08:30:1126902` 在 `/proc/locks` 为 `FLOCK ADVISORY WRITE 629226 ... 0 EOF`                   |
| batch lock       | `runs/pilot-pair-001/batch.lock` 保存同一 PID、acquiredAtMs `1788949958199`；设备/inode `08:30:881358` 同样由 PID `629226` 持有 WRITE FLOCK                                       |
| 批次控制平面     | `control-plane/process.json` 的 PID `629289`、birth `3283360`，与宿主实际 Node 进程相符                                                                                           |
| 观察状态         | `attempts/001-01/attempt.json` 在 `10:42:54.788 UTC` 继续更新 `lastObservedAtMs`，phase 为 observing；deadline 为 `11:03:20.774 UTC`                                              |

本次不仅检查 PID 存在，还关联了命令、cwd、启动身份、锁文件的实际 inode 以及宿主内核锁。锁文件残留本身不证明 runner 存活；PID 也可能复用。当前两个锁确实在内核中由正确 runner 持有，因此**此刻不能再 run/resume，应该观察原批次**。受限执行环境可能缺少宿主进程视图，不能把该视图中的 PID 缺席解释为原进程结束。

## H1 首次验收：运行中批次的接续判断缺少明确入口

发现位置：`docs/BENCHMARK_RUNBOOK.md`
的“新会话从这里开始”写“有未完成批次时执行bench:resume”；“模型试跑、单轮验收与接续”提到内核文件锁，但没有说明如何定位runner、读取锁持有人并决定是否只观察。现有
`ps` 示例仅匹配准备/校准 worker，不会匹配当前 `tools/benchmark/cli.py run`
进程。示例 resume 又使用尚未开始的 `acceptance-30-001`，没有给出当前 active 批次的接续示例。

需要实施方补充的精确内容：

1. 先刷新 status，再从 `runs/active.json` 读取当前 run-id；列出 `run.json`、
   `attempts/*/attempt.json`、`report.json` 和两把锁的入口。
2. 明确“有未完成批次”至少分为 runner 仍持锁与 runner 已退出两种情况；前者只观察 status/report，后者在宿主核对 cmd/birth 与锁释放后才用原 run-id 接续。提供实际 runner 查询及 Linux
   `/proc/locks` 或等效命令，不将空的准备 worker 查询当依据。
3. 补充当前接续命令 `npm run bench:resume -- --run-id pilot-pair-001`
   的前提条件。不删除 active/lock/intent 文件来绕过检查，不因模型尚未结束创建新批次。

正确的当前入口为：

```bash
export PATH="$PWD/.cache/opensandbox/node/bin:$PATH"
export BENCHMARK_LAB_ROOT="$(dirname "$PWD")/benchmark-lab"
npm run bench:status
npm run bench:report -- --run-id pilot-pair-001
# 只有宿主确认原 runner 已退出且锁已释放，才执行下面的接续命令：
# npm run bench:resume -- --run-id pilot-pair-001
```

`resume --help` 与 `report --help` 已实际读取，支持
`--run-id`/`--config`/`--lab-root`。当前已有安全的内核锁证据，不需要以实际启动第二个 runner 的方式验证拒绝行为。H1 修复后应由验收方只读复核文档中的命令和分支，本次未自行修正文档。

## H1 修复后独立复验：PASS

复核 `docs/BENCHMARK_RUNBOOK.md` SHA256 为
`07442c1ee211b3a32736f7740848310f4a5cca6f684eb03ccf055aa5dc66aeae`。修复由实施方完成，验收方只读执行文档命令并更新本报告。

1. 新会话入口第 25–28 行已明确区分“未完成且持锁：只观察”和“原 runner 已退出且锁释放：原 run-id
   resume”；新批次启动仍以没有未完成批次和准备冻结为前提。
2. 新增“检查当前runner”第 147 行起列明 active/run/attempt/report 入口，解释 `allocated`
   不代表尚未执行。第 155–179 行 Python 片段只读取外部 JSON 与宿主
   `/proc`，关联两锁的设备/inode、内核 PID、startTicks、命令和 cwd。
3. 验收方先实际刷新 `bench:status`（退出 0，冻结为 true、active 为
   `pilot-pair-001`、六项计数仍全部 30），再**逐字执行新增 Python 片段**，宿主执行退出 0。结果仍为 PID
   `629226`、startTicks `3283322`，正确的当前 run-id/ 两题命令及仓库 cwd。两锁分别匹配
   `08:30:1126902` 和 `08:30:881358`， `/proc/locks` 中均由 PID `629226` 持有
   `FLOCK ADVISORY WRITE`。
4. 第 182–185 行明确当前分支只能观察，要求同时核对 run-id/cwd/启动身份/持锁关系；保留 PID 复用、受限进程视图、残留锁文件边界，并禁止删除 active/lock/
   intent 绕过检查。第 187–193 行提供实际 `pilot-pair-001`
   report 命令及带退出/ 解锁前提的 resume 示例，关闭了错误照抄尚未开始 acceptance 批次示例的缺口。

复验时 `001-01` 仍 observing，`lastObservedAtMs=1788950837639` （2026-09-09 10:47:17.639
UTC），模型执行、child 协议和评分结论仍 pending。因此新会话可仅凭现有文档与实际状态作出“继续观察现有 runner”的正确判断，无需询问实施方，也无需启动第二个 runner 来探测锁。H1 已关闭，当前范围没有 must-fix。此次没有重复执行已通过的 doctor/report，也没有执行注释中的 resume 或启动命令。

## 未实际验证的范围

没有创建 session、提交 prompt、run/resume、取消/停止进程或容器、运行评分、重新导出 trace 或执行分析；没有读取输出私密连接值和密钥。宿主访问及公开 status/
doctor/report 的外部报告刷新使用审批后的权限。本次仓库仅新增本验收报告。

尚未实际验证 runner 重启恢复、网络超时意图对账、评分中断恢复、重复启动的运行时拒绝、真实 child 分工/patch 传输、模型服务实际输出、最终评分/trace/清理和 30 题单轮实验。这些需要后续阶段的真实证据验收，不由本次定位与接续判断 PASS 替代。
