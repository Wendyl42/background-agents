# 016观察超时与v3接续

2026-09-10。证据目录
`runs/audits/observation-timeout-016-1789033865807/`；独立验收见[OBSERVATION_TIMEOUT_V3_REVIEW.md](OBSERVATION_TIMEOUT_V3_REVIEW.md)。

## 本次阻断

`acceptance-30-001-behavior-v2`在016 CooperBench
dirty-equals执行中因观察请求超时进入blocked。009长提示修复已通过009和014真实提交；此次为不同问题。001–016均已收尾，017–030未开始。016模型开始后约184秒被runner取消，保留modelExecution=infrastructure_failure、childProtocol=failed；最终产物、trace、分析和清理均complete，评分按配置跳过。本次不重跑016或将其替换成成功样本。

旧client只保存generic timed
out，不能确定失败的具体端点及网络阶段。原日志显示，最后成功观测到取消的间隔44,099ms；其间父children
GET在本地耗时11,150ms，D1总耗时11,157ms；同一窗口host采样有10,393ms空档。清理时GET随后恢复正常。容器采样内存峰值约0.9–1.1GiB/个，低于各自限制；这不能排除未采集到的主机或磁盘压力。现有证据只支持本地读取链路出现短暂停顿，底层OS/网络原因未确定，不把容错修改描述成已彻底消除停顿。

## 修复

只对GET的transport错误及HTTP502/503/504作有次数上限的重试；每个读取请求最多3次尝试，每次使用新的sig1
nonce。POST及其他变更请求始终只提交一次，不借此重试模型或重复创建session。401/403等永久错误及无效JSON不会作为短暂错误重试。

读取重试服从原deadlineAtMs；单次socket等待不超过剩余模型时限，收到停止请求或到达deadline就退出观测并沿原取消/采集/导出/清理流程收尾。清理阶段释放观测期限，不会因旧deadline而拒绝必要清理。恢复过的读取故障仍保存在readDiagnostics和异常索引；连续读取失败仍会阻断，不无限重试。

每个attempt的api-requests.jsonl保存请求起止时间、方法、去掉查询值的路径、客户端/服务端请求ID、等待上限、耗时、HTTP状态或异常类型。它不记录模型prompt、查询值、认证签名或响应正文。该文件是独立诊断证据，canonical
trace仍沿用已有导出流程；汇总的readDiagnostics给出其路径与计数。

## 版本与进度

runner实现有变动，因此不热改或resume旧v2，而创建新配置`experiments/behavior-30-v3.json`和新批次
`acceptance-30-001-behavior-v3`。配置只改变suite名称；模型、预算、评分策略、题目、镜像和既有环境验证均复用。新批次保留30项计划，通过原SHA引用继承001–016（包括001–005更早来源），只调度017–030。旧两个批次、016失败、005用户中断及009拒绝/恢复记录均保留。

必要验证：全benchmark89项通过，包含真实loopback超时恢复、变更请求不重试、截止/停止、分页不重复、两级继承及当前批次状态入口；ruff通过。修改前后1,642份原配置/批次文件hash均相同。没有重新下载、准备、构建镜像、评分、校准或补跑模型。

代码、实际分配及一次启动交接均独立验收PASS。新批次`acceptance-30-001-behavior-v3`已启动，继承001–016，仅调度017–030；启动快照确认017
observing，root为 `4eb7b9843e10fc250e497b188ca4393b`，有效消息1条，create/prompt
POST各1次、maxAttempts=1；模型预算1800秒、评分关闭、1642份原文件hash全同。

独立unit为`oi-bench-acceptance-30-001-behavior-v3-1789034824896-4ea33422.service`，PID960008、PPID717。证据保存为新run/startup-handoff.json及上述审计目录restart-handoff.json。此后Codex结束本轮，不持续守候；以下状态入口自动选择当前批次。

```bash
# 始终查看当前活动批次，不依赖npm，也不需要记住版本号
python3 tools/benchmark/service.py status

# 新v3批次的明确停止/接续入口
python3 tools/benchmark/service.py stop --run-id acceptance-30-001-behavior-v3
python3 tools/benchmark/service.py resume --run-id acceptance-30-001-behavior-v3
```

保留的旧v2会继续显示blocked；这是历史终态，查看当前批次应使用上述不带run-id的status。看到当前批次complete或新的blocked后，再调用Codex分析/排查并做阶段独立验收。
