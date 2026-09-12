# 故障任务单次补跑计划

本计划已执行完毕，当前complete。结果为3项模型completed、030再次OOM失败并确认应用参考补丁。请优先读[最终结果](FAULT_SUPPLEMENT_RESULTS.md)及[独立终验](FAULT_SUPPLEMENT_FINAL_REVIEW.md)。下方为原先登记的计划和启动记录，不再自动执行其中resume命令。

2026-09-11，用户在原30项已完成并验收后明确授权：判断哪些故障任务需要补跑，必要时执行。本补充实验用于取得较少外部中断的额外行为轨迹；原30项足以做阶段汇报，无需通过补跑把结果改成全成功。原始队列和结果保持不变，补跑数据单独统计，不进行best-of替换或自动重试直到成功。

## 预先确定的选择

| 原attempt           | 补跑attempt | 原因                               | 补跑每sandbox内存                      |
| ------------------- | ----------- | ---------------------------------- | -------------------------------------- |
| 003-01 Meson        | 003-02      | 观察读取超时，模型提前被取消       | 3072 MiB，沿用原值                     |
| 005-01 Pandas       | 005-02      | 用户关机中断，未获得完整预算下轨迹 | 3072 MiB，沿用原值                     |
| 016-01 dirty-equals | 016-02      | 观察读取超时，模型提前被取消       | 3072 MiB，沿用原值                     |
| 030-01 DSPy         | 030-02      | 已确认OOM，另保留原上游读取违规    | 3840 MiB（3.75 GiB），单独标注资源变化 |

001、008、011、013、014、015的正常deadline是原预算下的真实结果，不因结果不好而选择重跑。009已在原attempt内有据恢复完成，不再补跑。各选中任务仅追加一次，产生新session/新容器，使用原始题目与附录及原干净镜像，不向模型提供旧答案、失败反馈或参考补丁。所有任务保持原模型、2
CPU、parent+2 children、1800秒执行时限、官方评分关闭。

## 030新增OOM证据

此前终验已记录SSE断流和OpenCode exit
-9，但未确定进程终止原因。本次为判断补跑条件，进一步读取原`observations-001/host.jsonl`，确认：

- child容器`8ec12a71...`在1789040962435 ms发生Docker `oom`事件；
- root容器`0611b762...`在1789041414272 ms发生Docker `oom`事件；
- 两者采样内存峰值均到达原3072 MiB cgroup上限，与随后断流/进程终止时序相符。

直接证据另存`runs/audits/fault-supplement-plan-1789098204123/dspy-oom-evidence.json`，原数据未改。这支持容器内存限制耗尽的诊断，不能只以网络断流描述这两次失败。

030补跑只提高内存到3840
MiB；按本机容量为三个sandbox与宿主预留空间，启动doctor会按该最高profile检查，而不是只按3072
MiB检查。增加内存不能保证本次模型不再失败，结果仍如实保留。030原上游源码/PR/diff读取是已确认的违规；本次从新上下文和干净工作区开始，沿用禁取上游约束。若补跑再次发生同类违规或失败，仍标注，不继续采样直至出现“干净成功”。

## 实现、版本与验证

新配置`experiments/fault-supplement-v1.json`，冻结记录为同名`.lock.json`。
`taskResourceOverrides`只允许改变指定任务的memoryMib，不允许改变模型、时间预算或任意参数。原30条环境、任务清单及校准证据直接复用，四个目标镜像已核对存在，没有重建或重复校准。

`prepare-supplement`要求显式选择任务、源批次complete、原任务对象相同、证据/清理已完成，拒绝把completed或正常deadline任务放入故障补跑。它只落盘计划，不启动模型。新attempt的retryOf指向原run/attempt路径及SHA；后续执行校验这些引用。原30项分母和最终终验报告不改，新补跑报告的分母为4。

必要验证：99项benchmark测试通过，ruff通过，包括只分配不执行、原数据保护、第二次尝试编号、正常结果不被重跑、memory覆盖范围与原模型/时限保留。新配置按最高内存profile预检。原三个批次及配置共3719份文件SHA已保存在审计目录。

代码及实际分配独立验收PASS，99项测试通过；四个原镜像就绪、容量预检通过，实际可用14062MiB，按最高profile要求13568MiB。补跑批次已分配且原3719文件hash全同。

独立runner已启动，unit
`oi-bench-fault-supplement-20260911-001-1789098604386-afdf309f.service`，PID17537。启动交接已独立验收PASS：003-02新root为`2c5f0ae2243728df04b17d925d951496`，只有一条与原题SHA一致的有效消息，CPU2/RAM3072/1800秒/评分false；3719原文件hash全同。证据保存在新run及审计目录的startup-handoff.json。030实际资源与四项最终结果留到运行结束后验收。之后Codex结束本轮，不持续守候；四项完成或阻断后再分析及独立验收。

```bash
# 当前活动批次状态（不依赖npm）
python3 tools/benchmark/service.py status

# 本次补跑明确的停止/接续入口
python3 tools/benchmark/service.py stop --run-id fault-supplement-20260911-001
python3 tools/benchmark/service.py resume --run-id fault-supplement-20260911-001
```

原30项仍在`acceptance-30-001-behavior-v3`及其两级来源目录；其complete与结果不变。该补充计划不是原先“三轮90次”实验，也不用于声明新的正确率或因果提速结论。
