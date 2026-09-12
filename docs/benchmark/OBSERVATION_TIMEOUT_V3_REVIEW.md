# 016观测超时修复与v3接续独立验收

日期：2026-09-10。独立验收者仅审阅、进行隔离验证和只读证据核对，没有修复代码、修改原批次、调用模型、操作容器或守候运行任务。审计目录：
`../benchmark-lab/runs/audits/observation-timeout-016-1789033865807/`。

**代码阶段PASS，未发现阻断本次接续目标的缺陷。**
新实现为GET读取增加有界重试和诊断，不自动重试mutation或模型。应新建
`acceptance-30-001-behavior-v3`，保留001–016原终态，只执行017–030。不得在旧v2批次热改runner或覆盖016失败。

## 已有状态与原因边界

独立重算两个旧批次全部1,642份保护文件SHA，差异为零。016保持
`done / modelExecution=infrastructure_failure / infrastructure=["timed out"]`，从prompt提交意图到runner执行结束为183.639秒。其artifact
coverage、trace、analysis、cleanup均记录complete；独立逐文件核对trace的24份hash/bytes，结果complete、issues为空。官方评分按配置未执行，不能将基础设施取消解释为完整预算下解题失败。

原窗口中request `2ec74662`记录一次GET耗时11,150 ms、D1总时间11,157
ms；审计摘要另记录同期host采样空档10,393
ms，以及之后清理读取恢复正常。旧客户端没有记录最终失败请求的方法、端点及每次耗时，因此不能据这些相关时间直接认定最终超时发生在哪一层，或宣称OS/网络根因已经解决。本次修复减小瞬时读取失败直接终止任务的概率，并让后续失败具有可定位记录。

## 行为审阅

- 重试只适用于GET，最多三次请求尝试。范围为传输异常以及HTTP
  502/503/504；400/401/403/404/409/429等确定响应直接失败，不进入重试。POST及其他mutation始终一次尝试，未知提交结果仍保留原intent并阻断，不能重新提交模型直到成功。
- 每次实际请求重新生成sig1签名/nonce及客户端请求ID，避免重用签名被服务端拒绝。GET分页只在成功完整读取JSON后追加当前页；单页失败重试不会重复追加前面的页。
- observation范围使用原
  `deadlineAtMs`，每次读取timeout取配置值与剩余预算的较小值，读取前及成功/失败后检查deadline/stop，重试不会另分配模型预算。
  `ReadDeadlineReached`/`ReadStopRequested`被runner归类为deadline/interrupted，随后正常取消和收尾。context
  manager在异常时也恢复原读取范围，清理读取不会继承已过期的模型deadline或停止标志。
- 持续失败最终报出方法、去query的路径、尝试次数和诊断文件位置，并保持原基础设施失败收尾/阻断路径。当前attempt的API请求开始、成功、HTTP错误和传输错误追加落盘；记录耗时、timeout、状态和关联ID，不记录payload、query值、签名或响应正文。恢复过的读取错误仍保留计数和异常索引。
- `readDiagnostics`关联当前attempt的Client，包括清理等读取；分析时应据日志端点/时序区分，不能将该计数直接当作模型活跃期的观测次数。进程被强制中断时，最后一个started记录可能没有完成记录。
- `service.py status`省略run ID时读取active批次；start/resume/stop等操作仍要求明确run
  ID。该变更降低用户误看历史blocked批次的风险，不允许含糊停止另一批次。

时间边界：urllib的timeout限制socket等待，并非可抢占的硬实时墙钟中断；正在等待的读取以及既有Docker采集操作仍可能延迟取消。实现保证重试不重置deadline，并在读取边界检查停止，不能据此声称任意宿主挂起或缓慢传输都能在截止瞬间结束。最终工具/资源耗时继续依据实际trace与采样说明。

## 版本接续与必要验证

新 `behavior-30-v3.json`
与v2配置仅suite名称不同，评分false、模型、预算、完整题目清单、附录和环境均保持。既有
`prepare-continuation`复用已冻结环境证据，将v2中001–005的原路径继续继承，再加入006–016的已收尾路径；来源清单合并两级原文件hash。模型失败也是已完成attempt，不能被重跑。实现快照改变会拒绝旧v2直接resume，新v3分配后再核验当前源码及来源证据。审阅中提出的唯一低优先级记录问题已修正：`derivedFrom.reason`不再硬编码“仅改变评分策略”，改为准确的通用版本接续/原任务与环境证据复用说明。验收者核对最终文本和SHA，实现方针对该文字变更的14项继承测试再次通过；无其他实现改动。

独立运行针对读取与接续的必要测试：

```bash
PYTHONDONTWRITEBYTECODE=1 ../benchmark-lab/cache/adapter-venv/bin/python -m pytest \
  tools/benchmark/tests/test_api_resilience.py tools/benchmark/tests/test_continuation.py \
  -q -k 'not real_loopback' -p no:cacheprovider \
  --basetemp=/tmp/observation-timeout-v3-independent-review
```

结果：28 passed，1
deselected。排除项是需要宿主回环监听权限的真实HTTP超时测试；本工具沙箱此前已确认限制socket创建。实现方报告完整89项（包含该真实回环测试）通过、ruff通过，本次不重复全套测试或校准。独立测试覆盖读取成功恢复、持续失败上限、新签名、不记录敏感值、mutation不重试、确定HTTP不重试、deadline/stop与范围释放、分页不重复、二级继承、默认active状态和明确停止目标。

| 审阅文件        | SHA256                                                             |
| --------------- | ------------------------------------------------------------------ |
| api.py          | `5fba8f31eaf2798467e82c9f85bdf18b6c66bd90de6a6c605749feedaca56631` |
| common.py       | `443eabc64388ce65cfeade5e03282d75bed5c5519e17b3a7757f7e3cf7e47b4c` |
| runner.py       | `9aa4ad039074aee084cad59f1fe23ff67567265049c104ae05c0000e6a8246d5` |
| reporting.py    | `beeebf1235b877f90a84f4118690d9e708471d49440c198670d194cbe31e87f9` |
| service.py      | `b0f0fbb16e500d7d7eb03c398831906d6c4b03fa66acef462ece6b51748c7939` |
| continuation.py | `c759fe82634e06017f79110a775310637f733f55e317c8bdfb249e5f5bdda366` |

## 实际分配核对

**v3实际分配PASS。** 对 `acceptance-30-001-behavior-v3/`
只读运行完整实现/来源校验与冻结校验，1,634份两级原始文件hash和17份adapter快照全部通过；另对1,642份开工前保护文件复核，均未改变。新旧完整计划以及30条冻结环境证据逐项相同，没有重复准备或校准。

- 新状态allocated，继承恰为001-01–016-01，剩余恰为017-01–030-01，尚无新attempts目录。
- 001–005继续引用
  `acceptance-30-001`，006–016引用v2；新report保留005的用户中断、016的基础设施失败。phase计数为done16/not_started14，nextAttemptId为017-01。
- 评分计数为历史scored5、按配置跳过11、评分失败0、pending14；没有将016未评分当作答错。
- active指向v3并保留v2来源。新锁的版本说明与实际接续理由一致。
- `source-evidence.json` SHA： `8a7c519045a408358e93367805f9e8461943ed478d3fd31a642be20514da1be1`。
- `experiments/behavior-30-v3.lock.json` SHA：
  `4f5e51d4590359faab421ad6369dd6417685dda11adb6c073e0f05c08f570675`。

## 一次启动交接核对

**本次修复、版本接续与启动交接阶段PASS。** 仅读实现方保存的 `restart-handoff.json`
单次快照，没有再次查询运行中状态、API或日志。快照时间1789034879119 ms：

- 独立unit为
  `oi-bench-acceptance-30-001-behavior-v3-1789034824896-4ea33422.service`，PID960008、PPID717，cgroup归属该user
  service，状态active/running。
- 首个新attempt为017-01（CooperBench GoChi），root为
  `4eb7b9843e10fc250e497b188ca4393b`，phase为observing；API消息恰好1条，submission messageId为
  `c96aab885cd387f2133f2f76c87e04f9`。
- 诊断记录中创建session与提交prompt的POST各开始一次，maxAttempts均为1；模型预算1800秒、officialScoring=false。该快照时读取失败/重试/恢复计数均为0。
- 快照再次记录1,642份保护文件未变。

启动后runner独立运行，本验收者到此结束，不守候。此结论不表示瞬时故障已复现并消除、017模型解题成功，或剩余14项与整批实验完成；最终行为、效率与证据在批次结束或下一阻断后再验收。
