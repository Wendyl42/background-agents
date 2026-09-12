# 四项故障补跑独立最终验收

日期：2026-09-11。批次：`fault-supplement-20260911-001`。本验收只读检查已有证据与终态，不修复、重跑模型、评分、重算分析或清理资源；
[准备验收](FAULT_SUPPLEMENT_REVIEW.md)保持原样。

**证据完整性与收尾PASS；不代表四项实验均有效或模型均成功。** 003、005、016完成模型执行；030在3,840
MiB配置下仍发生四次OOM，且成功取得并实际应用公开的CooperBench参考实现和测试补丁，属于明确污染样本，不能标为干净成功。四项均按配置跳过官方评分。已完成授权的一次补充，不应自动开启第三次尝试。

| 补跑                | 模型状态  | 原机器协议      | 模型阶段秒数 | 实际每容器内存 | 独立结论                                                        |
| ------------------- | --------- | --------------- | -----------: | -------------: | --------------------------------------------------------------- |
| 003-02 Meson        | completed | passed          |      535.896 |      3,072 MiB | 父子实际分工、取回和集成；本阶段未发现明确外部参考获取命令      |
| 005-02 Pandas       | completed | passed          |      830.500 |      3,072 MiB | 读/写功能分工与真实集成；本阶段未发现明确外部参考获取命令       |
| 016-02 dirty-equals | completed | review_required |      422.723 |      3,072 MiB | IsMac/IsEmail真实分工、父解决合并冲突；改写prompt的人工边界保留 |
| 030-02 DSPy         | failed    | failed          |    1,601.870 |      3,840 MiB | 四次OOM；参考实现及测试实际暴露/应用，最终无父发布和成功回复    |

这里的模型阶段为原 `promptIntentAtMs` 到
`executionEndedAtMs`，不包含全部setup/收尾，不能用它替代完整服务墙钟时间。四次原deadline差均为1,800秒，没有提高模型预算。

## 来源、配置与原cohort保留

独立重算准备审计 `fault-supplement-plan-1789098204123/original-cohort-hashes.json`
的3,719项，无变化。旧30项仍为单独cohort，005用户关机、003/016读取故障、原030失败及违规证据均保留。补跑仅有003-02、005-02、016-02、030-02四项，均repetition=2，retryOf的原路径/SHA精确匹配。源run
SHA与补跑记录一致，17份实现快照及当前冻结配置校验通过。

四个新root和全部新child
session均与对应原attempt的session集合不相交。原题文本、附录和完整提交prompt逐文件SHA与原attempt相同，并通过冻结prompt重新组合核验；四条API根消息均恰好一条、内容完整相等。运行镜像ID与各原attempt相同，没有改换任务环境。实际runtime
prompt.start与API模型记录均为DeepSeek Flash、默认reasoning。前三题各三个容器的host
identity记录均为CPU2/3,072 MiB，030全部六个历史容器均为CPU2/3,840 MiB。

补跑的runner请求诊断中，每题创建session和根prompt
POST各一次、maxAttempts=1。四项readDiagnostics均为0失败、0重试、0恢复；因此本次没有重现读故障，也不能据此声称原OS/网络延迟根因已被证明消除。030额外三条child
follow-up由父模型显式调用工具发起，同属该次attempt的原1,800秒预算，不是runner自动重复创建第三次补跑。

## trace、产物与分析文件

逐项只读校验结果：

- 96份trace hash/bytes全部匹配。12个session的原API分页均正常结束；event
  ID集合与normalized精确一致，无重复或漏页。四项分别保存230/220/112/340个event，218/208/100/316个工具调用，消息数分别3/3/3/6。
- 56份逐题analysis输出hash/bytes全部匹配。四份已保存summary均validation.valid=true，errors/warnings为空；没有重新执行分析器。
- 所有42个内容寻址patch文件的实际SHA均等于文件名。23条最终checkpoint/published元数据的SHA/bytes、12条服务端传输记录及对应patch均通过；前三题父最终checkpoint与父published一致。
- `trace-batch-001/collection`的四个输入目录逐文件与相应最终trace完全相同。五份batch输出hash/bytes通过，candidate=4、successfulRunCount=4、failureCount=0，failures.jsonl为空。此处success只表示分析成功，不表示模型成功或四个样本均有效。
- 四项 `benchmarkCorrectness.status=not_scored / reason=disabled_by_config`，没有scoring
  generation。模型自己运行的可见测试或泄漏测试均不等于官方评分。

原始API记录并非完整逐token流，工具输出可能截断；资源是离散host采样。分析中的重复操作比例不能直接解释为可删除工作、节省token或性能收益；四项样本不构成统计显著性结论，030还使用了不同内存条件。

## 前三项协作抽核

003：两child分别负责Cargo底层version/cfg/toml与manifest/interpreter；各有实际非空发布。父通过服务端取回两份准确SHA补丁，先check再apply，随后修改集成问题、运行自行重建的13个断言和Cargo验证脚本，最后发布10,389-byte
patch。可见输出有13 passed/ALL PASS，另有601 tests
collected；收集测试不代表运行601项，重建断言也不等于官方隐藏测试通过。

005：两child负责read_iceberg读路径与to_iceberg写路径。父取回两份发布，应用读路径和写路径的DataFrame部分，再整合共同的iceberg实现。早期可见测试有缺失API导入错误，后续也出现ninja构建失败；最终相同可见命令记录50
passed、1 xfailed。父发布15,779-byte集成patch，原失败输出未被覆盖。

016：两child实现IsMac/IsEmail，在重叠文件上产生真实三方合并冲突；父随后解决冲突并发布8,611-byte
patch。完整 `tests/` 因pytest弃用警告转错误在docs测试收集阶段失败；忽略 `tests/test_docs.py` 后476
passed。不能将这个结果写成完整suite全通过。两份child
prompt非原文逐字复制，原机器review_required保持；本次抽核实质分工及交付，不将机器检查替代完整需求语义或全部附录人工验收。

对前三项保存的全部工具调用扫描明确外部获取命令，包括curl/wget、网络git
clone/fetch/pull、requests/urlopen及webfetch/websearch，未发现实际外部参考获取命令；另抽核真实双child发布、父fetch、patch应用和可见验证。该范围不等于全面网络审计，也不能证明未保存的活动不存在。

## 030：OOM与样本污染分别成立

原host日志有四条明确Docker oom：

|      时间戳ms | 角色/session前缀                | container前缀  |
| ------------: | ------------------------------- | -------------- |
| 1789101225384 | TTL child `4b26f1d1` 初次运行   | `871c61875365` |
| 1789101305824 | stats child `6f21e7c3` 初次运行 | `02494552a407` |
| 1789101858000 | TTL child `4b26f1d1` 后续运行   | `1ebddba97db9` |
| 1789102466924 | parent `a781004d`               | `ca4287c897ba` |

四个OOM容器的采样usage峰值接近或达到3,840 MiB上限；并非四者都精确相等。其峰值分别为4,026,515,456 /
4,026,515,456 / 4,026,531,840 / 4,026,523,648
bytes。六个历史容器来自同一父、两个child的后续重建，不表示六个不同session或六个同时运行的容器。机器协议中的“Missing/distinct
container identity
evidence”包含其一session一容器假设的限制；本次六个容器身份和资源记录实际齐全。父无最终published和成功回复的其他协议失败则有原始证据支持。

外部暴露按原normalized工具事件次序核对，以下index从0开始，仅作定位辅助，callId为稳定锚点：

1. 早期curl到GitHub/PR diff有TLS错误、HTTP000和0 bytes；不能把这些请求判作已成功获取。后来GitHub
   API/页面及公开dataset请求有HTTP200和实际内容，早期TLS失败不能否定后续暴露。
2. stats child于1789101831235
   ms取得feature4的说明、参考实现和tests补丁，输出HTTP200与3,342/8,475/6,797
   bytes，并列出真实落盘文件。callId：`call_00_KAzUpyVRbaVqHYcVi7Gd0693`。同期另取回combined.patch以及feature1–5的tests.patch/feature.patch。
3. 1789101872119 ms实际 `git apply --check`并应用下载的feature4参考实现，输出
   `FEATURE PATCH CHECK OK / APPLIED`；callId：`call_00_ViEE8AhO2Zs4ZgTNYC3b6831`。下一调用实际应用tests.patch，输出
   `TESTS APPLIED`；callId：`call_00_f27MBbUiC0JTjg43PWgv4758`。
4. 随后恢复测试文件，却保留参考实现代码。stats child发布SHA
   `bb4ca16a60aa5e41ec489d5614cbbd9eac910907433dfb9b03d9504258424f80`（8,731
   bytes）。父真实fetch该补丁，之后实际应用其primitives/utils部分并整合cache代码。父最终12,640-byte
   checkpoint因此有可追踪的参考实现污染来源；无需靠仅出现URL或标题猜测泄漏。
5. 父曾显式纠正TTL child的上游PR偏题行为并要求重置，TTL child随后发布自身补丁；该纠正没有撤销stats
   child参考实现的暴露/应用，也不能恢复整个attempt的干净条件。

最终父OOM发生在更广范围可见测试期间，模型状态failed，父没有发布最终集成产物。即使此前有29 passed、1
skipped的局部测试，也不能将该污染且未正常完成的样本标成功。本阶段保留全部失败和行为证据，不提出自动第三次补跑。

## 收尾与证据锚点

四份cleanup均complete、remainingContainers为空、errors为空，取消范围与各自三session集合一致。12个最终checkpoint均有相应最终容器die事件早于采集时间，证明终态采集发生在该容器停止之后。旧容器重建的历史记录仍保留，030最终三个session的产物也完整采集。唯一service
launch的exit.json记录exitCode=0、endedAtMs=1789102615087，即2026-09-11 12:56:55.087（UTC+8）。

已仅读终态审计 `fault-supplement-completion-1789106656227/host-final.json`
完成最后核对：服务MainPID=0、Result=success、active/exited，ControlGroup为空，coordinator/batch两锁均无持有者；15个补跑历史容器全部不存在。当前仅原OpenSandbox
server运行，另外三个既有停止容器不属于本补跑，没有为验收执行全局清理。`completion.json`确认仅四项新尝试、没有启动后续重跑。
**本阶段最终证据完整性和收尾PASS，030实验污染/执行失败结论保持；不存在待恢复的运行任务。**

| attempt.json | SHA256                                                             |
| ------------ | ------------------------------------------------------------------ |
| 003-02       | `c9ea38304d3dddbb26299bfcc505fc35d8c3b09cae77c11ca4038e34a1c23fde` |
| 005-02       | `f7149a675ea2f0849baf4419199c982f0d8f03eadd04104b2e9ee7f7641e3d1b` |
| 016-02       | `9cc8f2955ae0cd4fa32d3fc6e63dbb2c843f9e0d2f8574ee89e85939efb4b0b7` |
| 030-02       | `1c68dbd37e5ddea56de969159ea831bbd86c605fd74761d85564586ac1f19fa8` |

独立只读核验脚本与结果暂存 `/tmp/check_fault_supplement_final.py`、
`/tmp/fault-supplement-final-review-validation.json`，供实施方存入本轮审计目录。最后仅读[补跑结果](FAULT_SUPPLEMENT_RESULTS.md)及交接/进度/运行手册顶部，结论、四项分母、030例外、未评分及不自动第三次补跑的说明与本验收一致；未为此重复运行数据或宿主检查。
