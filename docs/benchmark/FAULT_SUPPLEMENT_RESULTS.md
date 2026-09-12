# 四项故障补跑：完成结果

`fault-supplement-20260911-001`于 **2026-09-11 12:56:55（Asia/Shanghai）** 正常结束。4/4
done，runner
exitCode=0、MainPID=0、无当前blocked/下一项；四项产物、trace、逐题分析和清理均complete，整批分析4份成功、0份分析失败。模型执行状态是3项completed、1项failed，不能把批次complete当作四项都成功。

独立终验见[FAULT_SUPPLEMENT_FINAL_REVIEW.md](FAULT_SUPPLEMENT_FINAL_REVIEW.md)。原30项、原失败和所有既有证据不变；本补跑单独统计，各项只新增一次，没有第三次尝试或best-of替换。四项均按配置跳过官方评分，以下“completed”只表示模型工作流正常结束，不是正确性评分。

## 分项结果

| 补跑                | 模型执行  | 机器协议        | 消息跨度  | 结果含义                                                 |
| ------------------- | --------- | --------------- | --------- | -------------------------------------------------------- |
| 003-02 Meson        | completed | passed          | 8.75分钟  | 本次未再被原观察读取故障中断，获得完整执行轨迹           |
| 005-02 Pandas       | completed | passed          | 13.72分钟 | 本次未发生用户暂停，获得完整执行轨迹                     |
| 016-02 dirty-equals | completed | review_required | 6.89分钟  | 两child及parent完成，需求改写仍保留语义复核标记          |
| 030-02 DSPy         | failed    | failed          | 26.58分钟 | 实际3840MiB仍发生OOM，并确认参考数据取回、应用及产物污染 |

消息跨度取已有analysis/lifecycle的首message开始至最后message结束，不等于CPU时间或全部启动/清理墙钟。四项readDiagnostics的failures/retries/recoveredReads均为0，没有再次触发观察请求重试；不能据此把前后结果差异全部归因于读取容错修改。

前三项仍为每sandbox3072MiB、2CPU；030的实际容器限制均为3840MiB、2CPU。全部使用原DeepSeek
Flash、原题与附录、相同冻结镜像及1800秒预算。030资源变化单独标注，不能作为与原资源条件完全相同的对照。没有重复下载、镜像构建或环境校准。

前三项抽核了实际分工、双child发布、parent获取/应用和可见验证，未发现明确的上游获取命令。这不是对所有语义要求或网络行为的绝对保证。016合并冲突由parent处理；其完整可见test
suite曾因pytest弃用警告在收集阶段失败，忽略test_docs后有476 passed，不能宣称全suite全部通过。

## 030仍存在的两类问题

**内存故障未消除。** 原030-01在3072MiB下有2次OOM；本次提高到3840MiB后仍有4次Docker
oom事件：两个child初次执行、其中一个child重建后的执行，以及parent。它们的采样峰值接近或达到上限；其中3个峰值比上限少8–16KiB，不能把采样当成连续精确峰值。OOM事件与随后的断流失败相互印证。本次不是正常deadline，尚需另行定位哪些进程/操作造成内存增长，不能声称增加到3.75GiB已解决问题。

**参考数据实际进入产物。**
最初webfetch/curl有TLS失败，不能把这些失败请求当成功读取。后续工具成功取回CooperBench公开dataset里的feature/test补丁，原日志有HTTP200和下载大小。030
child不仅查看文件，还实际执行了对feature4_feature.patch和feature4_tests.patch的git apply，有CHECK
OK/APPLIED/TESTS APPLIED输出。随后测试文件被恢复，但参考实现保留、发布为
`bb4ca16a...`，parent获取后又将其中primitives/utils代码应用到自己的工作区，最终checkpoint含有可追踪来源。这违反禁取参考解/测试约束，不能把030-02视为干净的独立完成样本或用来宣称协作正确率/效率优势。原030-01的上游读取与失败同样保留。

030共有3个session、6个历史容器：parent在同一attempt内追加child
prompt并引发容器重建，不是runner创建了多个root重跑。原失败message、后续成功message和最后parent失败均保存。固定3容器的机器协议规则存在既知计数局限，但parent没有最终publication/成功最终答复等其他问题仍真实存在。

按预先声明的单次补跑政策，本轮到此停止。若将来要获得030的干净稳定轨迹，应先开展独立内存诊断，并改进外部参考访问限制及重建后上下文保留，再预先登记新的验证条件；本次未自动开始这些额外实验。

## 证据与收尾

- 4个retryOf引用、新session、原prompt和镜像身份正确，原3719份文件SHA未变。
- 4份trace列出的96个文件、56份逐题分析输出、5份整批分析输出均由独立验收核对；collection与原trace逐文件一致，4份输入只纳入一次。42个内容寻址patch文件hash正确。
- 12个session、15个历史容器身份保留；实际宿主核对15个模型容器均已移除，两锁无持有者，service
  cgroup已释放。仅保留原OpenSandbox server运行及三个更早的停机容器，本轮没有清理这些开发资源。
- 原分析/trace/状态没有改写；本轮只读检查和生成补充说明，没有运行模型、评分或重新计算分析器。

最终审计在 `../benchmark-lab/runs/audits/fault-supplement-completion-1789106656227/`：
`completion.json`、`host-final.json`、`attempt-overview.json`、`oom-events.json`及完成补跑文件SHA清单。补跑原始结果位于
`runs/fault-supplement-20260911-001/`，每项都有独立`retryOf`指回原结果。

向导师汇报时保留“原30项 + 单独四项补充”的结构：前三项提供额外正常执行轨迹，030报告为未解决的内存限制及参考数据污染案例。原始失败仍留在原实验分母，不能用补跑替换后重算成较高成功率。
