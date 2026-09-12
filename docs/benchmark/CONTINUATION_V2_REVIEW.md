# 行为观测接续 v2 阶段独立验收

日期：2026-09-10。验收者为本阶段独立 sub-agent，仅审阅与验证，没有修复实现或改写实验结果。授权依据为[暂停交接顶部三项安排](../BENCHMARK_PAUSE_HANDOFF.md)。

**实现阶段 PASS；未发现阻断本次接续目标的实现缺陷。**
官方评分默认关闭，真实任务环境、父子协议、产物交互、trace 与效率观测保留；旧 001–005 应通过只读引用继承，006–030 由独立 runner 调度。此结论不表示剩余 25 项已经运行或整批验收完成。验收最终核对时真实任务尚未启动；实现方已记录宿主模型代理 127.0.0.1:7890 恢复、原 OpenSandbox 服务恢复及认证 API 检查，可以交付独立 runner 启动。

## 核对范围与证据

审阅 `tools/benchmark/{common,reporting,runner,cli,continuation,service}.py`、新增与相关回归测试、
`experiments/behavior-30-v2.json`
及运行手册的独立启动/状态/停止/接续入口。本次没有调用模型，没有执行官方评分、30 题校准、下载、镜像构建或容器操作，也未连接原批次 SQLite。

对实现方保存的 `runs/audits/continuation-v2-implementation-20260910/original-state-hashes.json`
独立重算全部 18 项 SHA，差异为零。覆盖旧配置、两个 benchmark 版本锁、题目清单、旧 suite
lock、旧 run/report、两份关机请求/终态记录，以及五份 attempt 状态。另只读调用
`require_freeze`，30 项冻结环境关联证据均通过；没有重复校准。新旧任务计划完全相同，新配置只有
`suite: pilot-30 → behavior-30-v2` 与新增 `officialScoring: false` 两项差别。

| 旧 attempt | 保存的模型状态         | 收尾 / trace               | attempt.json SHA256                                                |
| ---------- | ---------------------- | -------------------------- | ------------------------------------------------------------------ |
| 001-01     | deadline               | done / complete / complete | `0cc1a22fee602b85310c2ef76c6f44fc99562dda32e9151d3b8bda0779a011f9` |
| 002-01     | completed              | done / complete / complete | `5f3ff3c69422720847e5dac15a56072b5218569ccd2dc03df50b125da3a2c05d` |
| 003-01     | infrastructure_failure | done / complete / complete | `992ede644faf21cb6ecc1c0ebdffaa5497e4de81c9b15646ec05f139acd3bfee` |
| 004-01     | completed              | done / complete / complete | `a60aec397255d54a7ef5124430c6fc64ec99e2354ea0a90ce49bc6eb91e553c0` |
| 005-01     | interrupted            | done / complete / complete | `ccd0d7af0af36811ac36a9d32c34d6db539a0a465805e23596be675dd5db4be6` |

旧批次状态仍为
`interrupted`，旧目录不存在 006-01。005 的用户关机中断及已有评分早退记录均保留，不能据其
`resolved=false` 解释为完整模型预算下失败。

## 行为与恢复结论

- `officialScoring` 缺省为 false，并拒绝非布尔值。关闭后先记录
  `benchmarkCorrectness.status=not_scored / reason=disabled_by_config`，不启动 grader、不创建 scoring
  generation；trace
  hash、父子身份/发布/取回/服务端交付链与运行配置检查仍执行。CooperBench 的官方评分引用单独标为未评分，关闭评分不会豁免真实产物交付检查。
- 显式启用评分的失败保持 `scoring.status=failed` 与
  `benchmarkCorrectness.status=infrastructure_failed`
  等原失败状态。已有 scoring 目录不能被跳过逻辑覆盖。汇总分别计算历史已评分、按配置跳过、评分失败与尚未评分；不会把跳过评分写成答错或异常。
- `prepare-continuation` 要求新 run
  ID，只允许 suite/评分策略改变，验证旧完整任务计划与冻结证据，拒绝未收尾或只有零散文件的旧 attempt。源 batch
  lock 以只读文件描述符加锁，不改写历史 PID 记录。完成项保留路径和 SHA 引用，不复制成新尝试；新目录保存原文件清单、配置来源和实现快照。
- 调度先检查停止请求，再跳过 inherited/done 项。剩余尝试使用原编号，未知 POST 结果通过持久 intent 只读协调，不能自动重发；评分/trace 恢复也不重跑模型。基础设施故障在当前证据收尾后阻断下一项，模型失败、deadline 与协议不满足则保留为观察结果。需要用户调查后的显式接续，不存在模型自动重试循环。
- 正常停止将请求落盘；观察循环取消并采集当前 attempt，完成后批次标
  `interrupted`。接续归档已确认的 stop
  request，保留历史，继续未开始项。原子状态文件、coordinator/batch 两锁、service 启动锁与 PID/birth 核对限制重复执行和错误清理。未知提交或收尾不完整时保留原现场供恢复。
- 进度和异常索引持续写入批次目录；缺依赖时 worker 在持有正常锁后记录
  `blocked`、异常与退出状态，不创建模型 attempt。服务无自动 restart，runner 退出后无需 Codex 继续轮询。
- 逐题 trace 导出/分析、模型用量及成本字段、执行时间和 host/runtime 采样路径保持；最终 batch
  analysis 纳入每个计划 attempt 的最终 trace，包括继承的旧 trace。资源采样与精确 CPU 活动、模型消息重叠与 shell 并发的限制仍明确记录。最终数据覆盖和效率结论留到整批结束再验。

## 必要验证与独立运行

独立运行以下 3 个相关测试文件：

```bash
PYTHONDONTWRITEBYTECODE=1 ../benchmark-lab/cache/adapter-venv/bin/python -m pytest \
  tools/benchmark/tests/test_continuation.py \
  tools/benchmark/tests/test_protocol_evidence.py \
  tools/benchmark/tests/test_protocol_primitives.py \
  -q -p no:cacheprovider --basetemp=/tmp/benchmark-continuation-independent-review-tests
```

本次工具沙箱内 62 passed；唯一未通过项为既有回环 HTTP 产物鉴权测试，创建 socket 时触发
`PermissionError: Operation not permitted`，尚未进入其行为断言。该环境限制不判作实现回归。另核对实现方持久化
`validation.json`：完整 71 项在允许回环的宿主验证中通过，ruff 通过；没有为该限制重复安装环境或再次扩大全套验证。默认 shell
Python 不含 pytest，测试复用既有 adapter venv。

独立检查保存的无模型 systemd 探针原始文件：unit
`oi-bench-independent-001-1789012537671-0d15f041.service`，PID 18356、PPID
717；三个 probe 的 cgroup 均归属该 user service，时间分别为 1789012537754 / 1789012540759 /
1789012543764 ms，最后
`exitCode=0`。结合实现方记录的启动命令退出边界，后两份 probe 在启动工具进程退出后仍成功落盘。原文件已持久保存在上述 audit 目录的
`systemd-probe/`。实际启动入口使用相同 service
manager、独立工作目录与追加日志输出，足以支持脱离 Codex 会话运行。

边界：当前
`Linger=no`，本结论覆盖 Codex/启动终端退出，不保证注销全部系统登录会话或机器休眠/关机后继续运行。运行手册已明确该条件及恢复命令。实现漂移硬门禁针对
`tools/benchmark/*.py` 和保存的 adapter 快照；其他工作区改动有 Git
commit/diff 记录，并非同样逐文件强制校验。正式运行期间应保留本次冻结实现。

## 审阅版本锚点

| 文件                | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| common.py           | `c051ffa5e042bd7e561ae4407985623bc65c7b6cf3b9eb6ef8389c664b317146` |
| reporting.py        | `9e7ab47ddb145ed8a31b15608b1efe9007f4ee7363668a36c9d34c4ddc255665` |
| runner.py           | `b504d3aa0e5a21604d5724b23491a4928dae9561982c20eea5539518c9d66c6f` |
| cli.py              | `2d3ae84d73b173757a66a56958dea0465187509c0ba9d5b87ed0c84014943d29` |
| continuation.py     | `f92cf76d71fcf5135f57a4df0549ad30ea54cca49caac6ccb3f76b128b1a8a35` |
| service.py          | `ba4c983433bbc6323de4ffb2883c1885ecffd62a12f57abf9a165af6eca1a25b` |
| behavior-30-v2.json | `3290959bdd08e09ea38a718070b03db8c418c04469ff6583eaab6e53ce1e12a0` |

## 实际分配后的同阶段核对

**实际接续分配 PASS。** 只读验证 `../benchmark-lab/runs/acceptance-30-001-behavior-v2/`
的配置、完整计划、实现快照及来源证据。 `validate_implementation`
核验 17 份 adapter 快照和全部 492 份旧批次文件 SHA 通过；新配置的 `require_freeze`
通过，30 条冻结任务环境证据与旧 suite 完全相同。

- 来源清单 `source-evidence.json` SHA：
  `9ebbe4fc08d94dbbbdd37bd25b4ba31a2927ab97ff05473173343f8ceb2dbfdb`。
- 新 `experiments/behavior-30-v2.lock.json` SHA：
  `45d6addfefa8e7a7c059a64e18498ee81947fc1459eeeba5cf419528a2f2365b`。
- 新状态为 `allocated`，原 30 项计划逐项一致，继承恰为 001-01–005-01，剩余恰为 006-01–030-01；无新
  `attempts/` 目录。`active.json` 指向新批次并记录旧 sourceRunId。
- 新 report/progress 为 `done=5 / not_started=25`，`nextAttemptId=006-01`，评分分类为历史
  `scored=5 / pending=25`。尚未执行的 25 项保持 pending，运行后才记录按配置跳过。第 005 项在新汇总中仍为
  `modelExecution=interrupted`，旧异常通过证据路径引用保留。
- 同目录 audit 的 `start-readiness.json` 记录
  `listening=true / modelTasksStarted=false`；本验收者没有启动模型、容器或服务。

本阶段验收到此完成。真实批次启动后无需本验收者或 Codex 守候；整批完成或阻断后，再从摘要、异常索引和按需原始证据进行下一阶段独立验收。
