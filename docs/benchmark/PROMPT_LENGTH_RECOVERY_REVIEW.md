# 009 API prompt 长度阻断修复与恢复独立验收

日期：2026-09-10。验收者为独立 sub-agent，仅审阅与验证，不修复代码、不修改运行状态或数据库，不调用模型、不操作容器。审计目录为
`../benchmark-lab/runs/audits/prompt-length-block-1789018224918/`。

**长度修复及本次恢复预审 PASS。**
009 的旧提交被确定拒绝，未进入模型队列。允许在脚本全部条件仍满足时，恢复同一 009 attempt、同一 root
session 的首次实际模型提交。这不适用于提交结果未知、已有 message 或已有模型活动的尝试，也不授权重跑 006–008。

## 阻断原因与未执行证据

009 Pytest 的完整提交为 77,643 个 UTF-16 code units，SHA256：
`011e05518c80f68d31eb0fa4dcb537b4523b62cd9f058b3f11b86fc116509988`。旧 API
schema 的上限为 64,000；router 在转发入队前返回 400，旧通用错误文案掩盖了长度原因。原 attempt 保持
`phase=prompt_intent / modelExecution=pending`，没有 submission，基础设施记录和原 runner 日志均为该 root 的 prompt
POST HTTP 400。

验收者从 `control-plane-before/` 的原 SQLite、WAL、SHM 复制到 `/tmp`
后只读查询，没有打开运行库或更改原快照。结果如下：

- DO 外部名为 `907666c53a5a9306fa4d7aa8eb388d8b`，与009 root完全一致。
- messages 表为 0 条，events 仅一条 `ready`；session 状态 `created`。
- ready 中 `opencodeSessionId=null`；startupAttemptId 与已保存容器标签一致。
- 当前停止后的 DB 与 WAL 均与原始审计快照 SHA 相同。另审阅容器观察记录：
  `promptStartLogLines=0`，容器归属与 root/provider ID 一致。

`sqlite-inspection/`
是已处理过 WAL 的查询副本，文件字节不同于原快照；本验收直接从原快照另建副本重读，确认了相同结论，没有只依赖该查询副本或只凭 HTTP
400 判定未执行。

独立重算 `protected-file-hashes.json` 的 688 项，差异为零。006、007为 `completed`，008为
`deadline`；三者均
`phase=done / cleanup=complete / trace=complete`。008的完整预算终态保留。旧001–005及005用户中断记录不变。

## 修复审阅与验证

shared 定义唯一 `MAX_API_PROMPT_CHARS=128_000` 和 `apiPromptContentSchema`，外部
`sendPromptRequestSchema` 与内部 `enqueuePromptRequestSchema` 均使用它。Web prompt schema 的原
`64_000`
上限保持。新的长度错误在 router 的入队转发前明确返回400；鉴权、非空内容和附件检查保持。未截断、改写或缩短benchmark原文。

独立按冻结 prompt
hash 读取30题原文，以现有纯函数组合相同附录后重算 UTF-16 长度：30题全部适配新上限；超过旧上限的恰为009（77,643）与014（66,169）。这里只做文本和schema检查，没有重复环境准备、校准或模型试跑。

独立运行必要测试均通过：

```text
shared src/types/boundary-schemas.test.ts：75 passed
control-plane src/router.session-prompt.test.ts
  + src/session/enqueue-prompt-contract.test.ts：10 passed
```

测试覆盖超过web上限但合法的完整API内容转发、API精确上限/超上限、入队边界以及拒绝时无转发。另核对实现方记录的shared先构建、shared/CP
typecheck、ESLint和Prettier通过。 `control-plane-revision.json`
中7份TS源码和4份shared构建输出，与当前文件及保存源码快照的11个SHA均一致。17份Python
runner源码及其快照、旧来源清单通过既有 `validate_implementation`；未热改runner。

## 恢复程序审阅

审阅 `recover_benchmark_prompt_009.py`，SHA256：
`5f3c570f69ff48407ae153852c98f9a431ed6e9f144d2274500bed3ab9db5235`。本程序是该固定attempt的一次审计恢复，不是自动重试机制。

程序持有coordinator/batch两锁，要求原009状态和hash、确定400错误、pending模型状态、无submission、批次blocked、runner及保护文件hash、原文hash和修复版本hash全部符合。还要求控制平面原PID/birth已结束、当前DB/WAL与已审定原快照相同、数据库无message且仅ready，以及精确root/provider/container归属仍在运行；条件不满足即拒绝。

应用阶段先保存当前未使用容器的checkpoint并要求空patch，再按照当前配置延长同一sandbox到期时间。续期意图和返回值落盘，不以重建容器或创建新session替换现场。之后将原
`prompt_intent`、400原因、旧提交/截止/结束时间和原状态hash保存到
`submissionRejections`；旧attempt完整副本和日志也留在审计目录。同一状态仅回到
`created`，移除已被拒绝请求的执行时限，保留原root和完整prompt。正常runner才会进行首次成功入队并从该时刻获得原配置的30分钟墙钟预算。

本次恢复不修改DO数据库，不重新提交任何已有模型message，不重复006–008。旧基础设施错误作为历史证据保留，批次单独记录从009生效的
`controlPlaneRevisions: prompt-api-128k-001`；不能把此前运行解释为使用该新API版本。原子写入中途意外中断会保留已落盘证据，需要再次审定状态；本结论不允许绕过检查强行重复脚本。

## 应用后的同阶段核对

**实际恢复 PASS。** 对
`recovery-applied.json`、续期意图/响应、空checkpoint、009当前状态、batch版本记录和688份保护文件作只读复核。应用时间为1789018923674
ms，`modelSubmitted=false`。

009与恢复前相比，变化仅为phase、旧三项时间及新增的 `submissionRecovery/submissionRejections`；root
session、原完整prompt SHA、pending模型状态均不变，没有submission。旧意图引用的 `beforeStateSha256`
精确等于审计副本，正常runner可从 `created` 继续。空checkpoint为0 bytes，SHA为
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。原sandbox的到期时间由05:59:53.308983Z延长至06:22:03.634035Z，续期意图和实际响应一致。
`controlPlaneRevisions` 从009记录修复版本，其记录SHA为
`1fc65d88accb5fa1b2d4aac21de05d30240ccac2dbd1d7dd7f13f7fe5d6e1cbb`。688份保护文件再次校验无变化。

## 一次启动交接核对

**本次修复、恢复与启动交接阶段 PASS。** 仅读实现方保存的 `restart-handoff.json`
单次快照，没有再次查询运行API、日志或任务进度。快照时间为1789019069797 ms：

- 新独立unit为
  `oi-bench-acceptance-30-001-behavior-v2-1789019014868-22a22eb1.service`，PID300268、PPID717，cgroup归属该user
  service，状态 `active/running`。
- 009仍是原root，进入 `observing`；首次有效submission的messageId为
  `248b74d3e048d947faca88baffbf59c4`。
- API消息恰为1条，状态processing，消息内容SHA与原完整prompt完全相同；没有重复入队证据。
- 新模型时限为1800秒，`benchmarkScoringEnabled=false`，修复版本为
  `prompt-api-128k-001`，快照记录全部保护文件未变。

本阶段结束后runner独立运行，验收者不守候。此结论证明已恢复同一009的首次实际提交，不表示009解题成功、其最终证据完整或整批完成；这些留待批次结束或下一阻断后的阶段验收。
