# 故障补跑准备阶段独立验收

日期：2026-09-11。独立验收者仅审阅、运行隔离单测和只读核对证据，未修改实现、原批次或数据库，未调用模型、操作容器、清理镜像或重复校准。授权依据为用户本次要求判断故障实验是否需补跑并代为执行。审计目录：`../benchmark-lab/runs/audits/fault-supplement-plan-1789098204123/`。

**代码与补跑计划阶段PASS，未发现阻断问题。** 允许另建
`fault-supplement-20260911-001`，仅对003、005、016、030各增加一次第二尝试。原30项结果及失败保留，不以新结果替换原结果，不把六项正常deadline或已恢复完成的009重新运行。

## 选择依据与原证据

源cohort `acceptance-30-001-behavior-v3`
状态complete。独立重算审计保存的3,719份原文件SHA，差异为零。四项原attempt均done、trace/analysis/cleanup/artifact
coverage完整：

| 原attempt | 原模型状态             | 本次补跑理由                       | 新attempt | 每sandbox内存 |
| --------- | ---------------------- | ---------------------------------- | --------- | ------------- |
| 003-01    | infrastructure_failure | 观测超时使执行提前终止             | 003-02    | 3,072 MiB     |
| 005-01    | interrupted            | 用户关机请求中断，未用完原模型预算 | 005-02    | 3,072 MiB     |
| 016-01    | infrastructure_failure | 观测超时使执行提前终止             | 016-02    | 3,072 MiB     |
| 030-01    | failed                 | 原父/子容器有明确OOM证据           | 030-02    | 3,840 MiB     |

验收者从030原 `observations-001/host.jsonl` 独立读到两条Docker `oom` 事件：1789040962435 ms的child
`e5533aee4482c261694211d5d2d5edca`，以及1789041414272 ms的root
`2ccb5a8cb4d867ed274e5982bc66fce6`。完整container
ID与原sessionTree匹配。审计记录两者采样峰值均为3,221,225,472 bytes，等于原3,072
MiB上限。这为单独提高030的内存提供了实证依据，不保证提高到3,840 MiB后不会再次OOM或失败。

原030上游读取违规结论和原trace继续保留；本次使用干净冻结镜像、新session、新attempt采集一个补充样本。若新尝试再次失败或违规，仍如实保存，不继续重试到成功。030改变资源条件，后续效率分析应明确区分，不能把它作为原3,072
MiB条件下的同一次试验，或据补跑成功冲销原违规。

## 实现与资源路径

- `prepare-supplement`必须明确提供source、new run ID和task
  ID选择；源batch必须complete，选中task与原冻结task逐字段相同，原attempt必须done、trace和cleanup
  complete。completed/正常deadline不可作为该故障补跑入口的选择。
- 每项只新增一次attempt，原编号前缀保留、repetition增加到2。 `retryOf`记录真正原批次ID、原attempt
  ID、路径、SHA和模型状态；003/005指向最初批次，016指向v2，030指向v3，不错误地将全部原证据解释为v3新执行结果。
- 分配路径只写计划、配置、版本快照与报告，不检查或启动模型服务，不调用run_attempt。后续独立service以resume进入正常runner；源码、配置、源batch状态SHA和四项原attempt
  SHA需通过核验。原有GET重试边界、mutation不自动重试、停止/接续和证据收尾机制保持。
- `taskResourceOverrides`仅允许memoryMib，必须为正整数，拒绝布尔值、非法task
  ID及额外预算/model字段。有效task配置传入run_attempt及需要恢复的控制平面，resourceProfile保存CPU/内存；顶层基础配置不被原地修改，前三项仍3,072
  MiB，只有030为3,840 MiB。
- 对内存的实际传递还审阅了既有runner的sandbox-settings写入、控制平面归一化和子session设置继承路径。3,840是有效正整数，不会在设置边界被取整回原值。四个任务使用各自冻结镜像，切换任务会重建相应控制平面配置。
- doctor按最高task内存计算容量门槛：`max(3840 × 3, 8192) + 2048 = 13568 MiB`。实施方报告的当前可用内存满足该门槛；启动仍会重新检查实际内存与磁盘，不据准备时采样跳过检查。CPU、模型、完整prompt、1800秒预算和officialScoring=false保持。
- 补跑report仅包含四个新attempt，JSON保留supplement来源和retryOf；原30项不并入四项分母、不做best-of选择。整批trace分析也属于这个独立补跑批次。

## 冻结证据与必要验证

`fault-supplement-v1.json`相对v3配置只增加suite名称、明确的supplementPurpose及030内存override。新lock的30条环境证据、manifest/benchmark锁、appendix
SHA均与旧v3完全相同。独立调用只读 `require_freeze`，30条关联校验通过；没有重新构建镜像或校准。

独立纯计划计算得到准确四项
`003-02 / 005-02 / 016-02 / 030-02`，retryOf路径/hash与各原attempt一致。必要单测结果：

```text
test_supplement.py：10 passed in 0.39s
```

覆盖只分配不启动、原结果不修改、源batch/原attempt漂移拒绝、正常结果排除、task变化拒绝、内存只作用指定任务、其他模型预算不变及非法override拒绝。另核对实现方报告完整99项benchmark测试通过和ruff通过，本次未重复整套回归、环境校准或模型试跑。

| 审阅文件                 | SHA256                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| common.py                | `0b43133f0c2583cceded9e56492ce2e8793286152db7a38721c0c14837cbcdd7` |
| cli.py                   | `7988c6bcb49f8fb3398784828c74776ea1bb4e4dd6e0f267485a07e56fce9558` |
| continuation.py          | `574dcb083559d97c6ccfc216ec6ca634c22ef0183ee5c865acf1a16357f15d75` |
| reporting.py             | `db3b41d29ac2a8f427246755d1616e3830d578dbae9b3ad17b73dfed0ba42fdc` |
| fault-supplement-v1.json | `dcc22d72e5cc6c3d7af16f4b39b1a653097a61bf8329985874365e8fe2167c6b` |

## 实际分配核对

**实际补跑分配PASS。** 独立只读核对
`fault-supplement-20260911-001/`：status为allocated、尚无attempts目录；恰为003-02、005-02、016-02、030-02，repetition均为2。17份adapter快照、当前配置和冻结证据、源run
SHA和四份retryOf SHA全部通过；3,719份原保护文件再次校验无变化。

源v3仍complete，其run SHA为
`860a4240d01d50d47ffbd843f9609a8bf1a3be7197b2a23b21cc2fa8a7c87590`；新suite lock SHA为
`aad3fd5461593dde248b73ac0ea0001e9dcec070224f90fadd1ecebbc1cac106`。报告分母仅4项，phase为not_started4、评分为pending4，nextAttemptId为003-02。四份有效task配置中，只有030内存为3,840
MiB，其他均为3,072 MiB；CPU2、Flash模型、1800秒预算和officialScoring=false全部保持。

## 一次独立启动交接

**本次补跑准备、分配与启动交接阶段PASS。** 仅读实施方保存的 `startup-handoff.json`
单次快照，未再查看运行中状态、API或日志。快照时间1789098712547 ms：

- 独立unit为
  `oi-bench-fault-supplement-20260911-001-1789098604386-afdf309f.service`，PID17537、PPID695，cgroup归属该user
  service，状态active/running。
- 首项003-02进入observing，新root为 `2c5f0ae2243728df04b17d925d951496`；API消息恰好1条，messageId为
  `8d8e202462d9a2728ae66e67c07f1a12`。
- 原文保持，prompt SHA为
  `43f420c00ddead0ea480f2c995452e86bf3f47dd510eaeac6b4c22d8b0a03a82`。当前首项CPU2、内存3,072
  MiB、模型预算1800秒、officialScoring=false。
- 快照再次记录3,719份原文件未变。实施方报告启动doctor通过，实际可用内存14,062
  MiB，最高资源profile所需13,568 MiB。

030的3,840
MiB仍是预先声明的后续task配置，其实际资源观测、四项最终行为和证据完整性留待补跑complete或blocked后的独立验收。runner现在独立运行，本验收者到此结束，不持续守候；本结论不表示四项补跑已经完成或成功。
