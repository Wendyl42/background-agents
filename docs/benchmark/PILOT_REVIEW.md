# 阶段 3：真实两题试跑独立终验

验收日期：2026-09-09；最终宿主清理核对时间 11:19:14 UTC。对象：外部
`benchmark-lab/runs/pilot-pair-001/`，计划 2 次、实际 2 次。验收方只读，不修复实现，不提交 prompt，不启动/停止容器或评分；仓库仅新增本报告。

**当前终验结论：PASS，P1/P2 已独立复验关闭，可以推进正常 30 题单轮。** 最终复验时间 2026-09-09
11:33–11:34
UTC。该 PASS 指两题真实接入、评分/证据链及协议报告缺陷修复验收通过，不表示两题模型解答成功。001 仍 deadline/协议 failed，002 机械状态仍 review_required，核心需求语义已由本报告独立审核；两套官方整体成功次数仍均为 0。受控恢复与 30 题执行结果继续独立验收。

以下保留首次结论、实际证据和两轮修复复验过程，不覆盖失败历史。

**初验结论：FAIL，P1/P2 为协议报告缺陷，修复并复验后再放行正常 30 题单轮。**
模型执行链、独立 sandbox、产物实际传输、官方评分、trace 导出/分析、清理子项均有真实证据。没有发现需要为本批重新执行模型或评分的缺陷。Packaging 超时和 CooperBench 未解出全部官方用例是保留的模型结果；不要求重试直到成功。

本批
`run.json.status=complete`、两个 attempt 都为 done；报告分母 2，unscored=0。下面判断建立在完成后的落盘数据上，没有把此前观察中状态提前验收为通过。阶段 2b 全 30 题环境及冻结已有独立 PASS，本次不重跑其校准。

## 实际结果与边界

| 维度           | Packaging，001-01                                                        | dirty-equals，002-01                                                                        |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 模型执行       | deadline；parent 与 metadata child 被截止清理，parser child 已完成       | parent 与两个 child 均 completed                                                            |
| 官方正确性     | resolved=false；F2P 10 通过/284 失败，P2P 3508 全通过                    | 原始 child 评分 both_passed=false；parent 集成 feature 2/IsMac 通过，feature 3/IsEmail 失败 |
| 原协议报告     | failed，7 条；漏列 parent 未发布等附录要求，见 P1                        | failed，两条“未收到完整原 prompt”；检测仅证明没有逐字子串，见 P2                            |
| 实际发布/交付  | parser child 发布 1 份；parent/metadata 未发布；parent 无 fetch/delivery | parent+2 child 共 3 份 published；2 次真实 server delivery                                  |
| 最终产物       | 3 个 session 均停止后采集完整 checkpoint                                 | 3 个 session 均停止后采集；最终 checkpoint 与各自 published SHA 相同                        |
| trace/分析     | complete；24 份 trace hash、14 份分析 hash 通过                          | complete；24 份 trace hash、14 份分析 hash 通过                                             |
| 基础设施与清理 | infrastructure=[]；完整清理                                              | infrastructure=[]；完整清理                                                                 |

统计中的“模型 completed”“分析 successful”分别表示执行结束、分析任务成功，不是 benchmark 解题成功。两套 benchmark 的整体成功次数仍均为 0，失败没有从分母移除。

## 版本、原始需求与正常 API 链

suite 锁 SHA256 为
`480cba951b605b6e8b483e1424c761c6f202f7b012314bda92be17153e54d0b9`。批次配置/套件锁与冻结相符，两份 benchmark 版本锁副本匹配；两个完整 task 对象均等于冻结清单中的对象。15 份
`adapter-source/` 文件逐一匹配 `run.json.adapterHashes`， `working-tree.patch`
匹配其记录 SHA，保留运行时未提交实现快照。

实际对比固定数据源和 `prompt.original.*.txt` 原字节：Packaging 原 prompt 为 43,336
bytes；Cooper 两 feature 为 2,328 与 2,293 bytes，三者逐字节相等且匹配任务 prompt
SHA。附录两份均等于仓库冻结附录，SHA 为
`5ef0aa1391c7ae42292be2f6dfcd877bb8923915477397b15309ab53bc0031a2`。submitted 与原 prompt/规定的 feature 分隔文字/附录组合逐字节相等；其 hash、prompt-manifest、API
message content 和 durable user_message event
content 全部相符。不存在通过改写 parent 的原始输入改善结果的情况。

| 角色             | Packaging session ID                                    | dirty-equals session ID                               |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| parent           | `ef4be59aa067b89758d8e95e5f77e362`                      | `0a67a14b7f687024359b563580c7db04`                    |
| spawn 第 1 child | `d65e3b554560b2031c5fa8cb662559f0`，metadata            | `200ccaae6ad271871b7767b5a5c85bfa`，feature 2/IsMac   |
| spawn 第 2 child | `9d9dd72622a077701d1f0e33d035dbac`，requirements/parser | `992656a00c600d9bfa325a2c78938458`，feature 3/IsEmail |

两树均是一个 root、两个直接 child，无第三层；API children、session index、normalized 事件、两个成功
`spawn-child` 输出及 `containers.json` 关联一致。每树三个不同 Docker container/native provider
object/startup attempt，镜像均等于该题冻结 runtime image：Packaging 为
`b8d0884a25d1…`，dirty-equals 为 `ed90a62ad0c1…`。六个 session 均有 OpenSandbox
ready、实际模型工具调用和 runtime `prompt.start`；六次 dispatch 均是
`deepseek/deepseek-v4-flash`、reasoning=null，并逐一对应原 API message
ID。这是实际请求分发/执行证据，不只是配置文件声明；不声称能识别模型服务内部实现。

Packaging 从 promptIntent 到 deadline 为配置的 1,800 秒；在 deadline 后约 1.26 秒进入停止流程。parser
child 成功完成的最终回复与 parent/metadata 的取消 execution_complete 各自保留。Cooper 三个 API
message 均 completed，三个对应 execution_complete 均 success=true。本批没有人工中断/恢复，不能据此验收受控恢复。

## 附录逐项核对

| 附录要求                                   | 独立核对结果                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 恰好两独立 child，使用 spawn-child         | 两题通过；六个实际不同模型容器、四次成功工具结果                                                                                                  |
| 两 child 创建后再等结果                    | 两题均无提前 get-child-status；Cooper 第二次 spawn 为 1788952054285，首次 status 为 1788952147573                                                 |
| 实质互补分工                               | Packaging metadata 与 Requirement/parser；Cooper IsMac 与 IsEmail；实际各 child 的代码修改与分工相符                                              |
| 不使用进程内 Task，child 不再分裂          | 两题所有保存的工具事件无 Task；API 树无 grandchildren，四个 child prompt 均禁止再创建 child                                                       |
| 同模型/推理设置                            | 四个 child prompt 明示；六个 runtime prompt.start 与 CP 配置一致                                                                                  |
| child 有原需求与 workspace/artifact 上下文 | Packaging 两段专门子任务含各自实现/验证/发布要求；Cooper 核心需求语义完整，未原样复制全文，见 P2                                                  |
| 读取 task.json，在工作树工作               | 六个 session 均有实际读取记录；产物从对应 `/testbed` 或 `/workspace/repo` 工作树采集                                                              |
| 不取上游/答案/隐藏测试，不 push/PR         | child prompt 有相应禁令；已保存工具调用中未发现 git fetch/clone/push、curl/wget、gh pr 创建、pip 安装候选命令；这不是所有外部网络行为的无遗漏证明 |
| child 实际 publish 并报告 sessionId/SHA    | Packaging parser 通过、metadata 未完成；Cooper 两 child 均实际发布且成功最终回复含精确身份                                                        |
| includeResponse 取回 child 最终结果        | Packaging 无 get-child-status 调用；Cooper 两个具体 child 的 includeResponse=true 输出均含非空成功最终回复与各自 SHA                              |
| parent fetch 原 revision，实际交付         | Packaging 无；Cooper 两个带精确 SHA 的 fetch 成功，server delivery 两条记录吻合                                                                   |
| 检查补丁、集成与验证                       | Packaging 未完成传输/集成；Cooper 实际 cat 两补丁、git apply 第 1 份、显式编辑整合第 2 份，后续可见测试 513 通过、新增测试 76 通过                |
| parent 最终回复保留两原 child 身份         | Packaging 没有成功最终回复；Cooper 最终回复准确保留两 sessionId 和 SHA                                                                            |
| parent 在集成/验证后 publish               | Packaging 只有 `publish --help`，没有真实 publish；Cooper 在最终 pytest 后实际 publish，后续 list/最终回复/最终 checkpoint 身份一致               |
| 修订后重新取 immutable patch（若有）       | 本批无 send-child-prompt 或 child 修订发布链；未将条件性要求冒充实际演练                                                                          |
| Cooper 按 spawn 顺序映射 feature 1/2       | 实际 IsMac(feature_id=2)→child 1，IsEmail(feature_id=3)→child 2；评分参数顺序匹配                                                                 |

Cooper 输出文件路径使用 `/tmp/child-200ccaae.patch` 和
`/tmp/child-992656aa.patch`；它们是便于识别的缩写路径，sessionId/SHA 参数、服务端交付和内容身份仍使用完整值。没有因文件名不是附录示例的全 sessionId 而误判丢失代码。

## 产物、交付与最终内容

Cooper 保留的三个 published revision：

| 发布者            | SHA256                                                             | bytes |
| ----------------- | ------------------------------------------------------------------ | ----- |
| child 1 / IsMac   | `2a8ff2f1541fb80b193bed568aec459b17f7c9f7c6e9566227288593913f9ee4` | 6259  |
| child 2 / IsEmail | `da1ff67281fabda94c0b4443caf8380796178fa5448f4cd9875f6cb2ccbc2575` | 4045  |
| parent 集成       | `688438325b3aadde9dcf509eb8810df45e4a68555a2193db5fe593cf8b031b0a` | 9103  |

两次 child publish 的真实 bash 工具输出、published
metadata、patch 文件 hash、child 最终回复、includeResponse 结果、parent fetch 参数、server
delivery、parent 最终回复以及官方 child 评分引用逐一对应。delivery 时间为 1788952151412 和 1788952151493
ms，recipient 都是同树 parent，字节数与补丁一致。parent 最后一次 pytest 为 1788952246021
ms，publish 为 1788952248049 ms，服务端保存为 1788952248140
ms；不是把 publish 帮助页或宿主 checkpoint 当作模型发布。

Packaging parser 发布 `adadab83f8811e2a36fe43df2dc039f8e1663cff6fdd60188fc5baff8e2bc4ef`（9205
bytes），其最终回复保留身份但 parent 未检索/交付。parent 的最终 checkpoint 为
`fffe5573b0491312858ef2212daf021ea8a7f73a7d16be8a23c55cb04d58c199`（10666 bytes），metadata
child 的 checkpoint 为 `cb8b510f04ce774a18389a511436e878f49f521d320a0306235ba8cc5ba92e43`（20494
bytes）。parent checkpoint 被明确用于该题评分，不称作已整合两个 child 或已主动发布的答案。

两个 attempt 的全部 immutable
patch 文件（19+7）按文件名逐 SHA 校验通过；最终 metadata 的 bytes/hash 也匹配。六个
`supervisor.shutdown_complete` 均早于相应最终 checkpoint
capture，artifactCoverage 六项 finalCapture=true；Cooper 三份最终 checkpoint 全部等于对应 published
revision，没有发布后未采集的工作树变化。

## 官方评分独立复核

Packaging `scoring-001/prediction.patch`
SHA 等于 parent 最终 checkpoint；官方 manifest/config/image 及上游版本沿用冻结配置。官方 report 与五份 P2P 原日志及
`test_output.txt` 一致：F2P 294 项中 10 通过、284 失败；P2P 为 1059+180+14+2245+10
=3508 全通过。patch_applied=true、error=null、resolved=false；存在真实失败测试输出，不能把它归类为无评分或基础设施异常。

Cooper 固定 evaluator 源码 SHA `cd69b9ce6fd04425a31e8e45ecb3eb8dbf379cef9c746107aecd0d92a5f438fc`
与 benchmark lock 一致；两个固定评分 test patch
SHA 也核对通过。评分器按固定上游规则过滤模型补丁中的测试文件。child_patch_sha256 顺序正是上表两个原 child
revision，parent_patch_sha256 是单独 parent revision，没有拿 parent 补丁替代原 child 分数。

- `official_child_patches`：两 child patch 各自 apply 成功，naive merge 在
  `dirty_equals/__init__.py` 与 `_other.py`
  冲突。**合并树测试未运行，但不能说整个 child 评分没有运行测试**：固定上游随后执行 lead/agent1-only
  fallback。 `transport-logs/898a555b4fff442791e52a97d3103c25.jsonl` 记录原 child
  1 对 tests1 为 78 通过，对 tests2 返回 2（缺 IsEmail 的收集失败），fallback 未同时通过。上游仅在两个 fallback 都通过时替换结果，因此最终保留 feature1/2 均 false、exit_code=null、both_passed=false；原日志完整保留这个过程。这是固定上游评分语义。
- `openinspect_parent_integration`：独立 `test_solo`，transport
  `b521234a8b8541ab9f2660e18ef65e22.jsonl`。IsMac 78 通过；IsEmail 59 通过/1 失败，唯一失败
  `test_is_email_false[user@domain.c-dirty5]`，parent 实现错误地接受该字符串。两维度总体均 false，不能把局部 feature1 通过说成 parent 全通过。

两份 `completion.json.scoreSha256` 都与实际 score.json 相符，评分状态分别 scored/
complete、没有 error/缺产物；单次评分 generation 保留。模型可见测试 513 通过与隐藏官方 Email 用例失败并不矛盾。

## Trace、分析与资源清理

两个 trace 各有 3 个 session；事件分别 226/97，其中完整持久化工具事件 214/85；消息分别 3。验收读取了六个 session 的全部 event/message
pages（各 1 页），末页 hasMore=false，raw/normalized 的 ID 集合一致、无重复；parent/child 关系与 message 终态相符。两份 manifest 的 24 个 hash/bytes 全部验证通过。runtime
142/132 条记录没有混入另一题 session，模型 dispatch 与 session/container 身份匹配。

两份 `analysis-001/` 的 14 个 output
hash/bytes 全部匹配，validation.valid=true、analysisProfile=`block-d0-v1`，3 节点/2 边/最大深度1。批次输入恰好两个 attempt 的最终 trace；collection 的 26+26 文件逐 SHA 等于原 trace，5 份批量分析 output
hash 匹配。batch-manifest/aggregate-summary 为 successfulRunCount=2、failureCount=0，
`failures.jsonl`
为空；runs.jsonl 的 summarySha 与各 attempt 分析一致。这里成功数是分析成功数，不能覆盖模型/benchmark 的失败分母。

trace
complete 的精确范围是“保存的 API 分页和文件完整”。missingness 明确说明 token/tool 状态采用持久化 upsert，不保留逐 token 全流、全部中间状态或原 SSE 顺序；关闭后的原 OpenCode
messages 未导出，个别大工具 stdout 本身已由 OpenCode 截断为工具输出文件引用。host 是采样数据，不是连续 CPU/shell 执行证明，不据此作精确 lifetime 峰值或可消除语义冗余的结论。没有为了补这些已声明边界唤醒已结束 sandbox。

cleanup 报告两题均 complete，cancelledSessions/removedContainers 与各自精确 session/
container 集合一致、remainingContainers=[]、errors=[]。Feature 官方评分容器和 Cooper 两个评分容器各有成功删除记录。11:19:14
UTC 宿主只读 `docker ps -aq --no-trunc` 再核对
**6 模型+3 评分=9 个精确 ID 均不存在**；两把内核锁均已释放。本验收未执行任何取消/停止/删除动作，没有以残留锁文件判断仍在运行。

## 必须修复的报告问题

### P1：协议检查遗漏 parent 发布与最终身份，覆盖范围不明

原 `adapter-source/reporting.py` 的 protocol_evidence 检查 child
publication、fetch、delivery、拓扑等，但没有检查 parent 实际
`oi-bench publish`、该 publication 是否对应最终工作树、parent 成功最终回复是否保留两 child 原 revision。001 实际只有
`oi-bench publish --help`，并无 parent
published.json；原协议 issues 没有列出该缺项。不能因本题已经 failed 就接受一个可能在其他题误报通过的验证器。

需要：逐项记录实际 publish 工具结果/metadata/patch
SHA 与最后 checkpoint 的关联；检查 parent 成功最终回复中两 child 的完整 sessionId/SHA；每个 child 的 publish、fetch、server
delivery、parent 引用及评分使用的 revision 应对应，不能各自存在但指向不同内容。`--help`
或宿主采集不得算发布。对于分工、需求完整性、集成验证、禁取上游等不能充分自动判定的附录项，明确标记自动覆盖范围和人工审核边界。

### P2：把“不是原文字面子串”误写为“未收到完整需求”

002 原报告的两条唯一 issue 来自
`original not in spawn.prompt`。验收逐段比较发现不仅有 Markdown/换行变化，还有 MAC 技术背景压缩和部分句子改述；所以“没有逐字复制”是事实。但 MAC 四格式/大小写/format/六 octet/regex/repr/两个修改文件，以及Email 格式/可选域过滤/大小写敏感/repr/两个修改文件全部保留，另有独立工作区、同模型、不再分裂、验证与发布的详细指令。未发现实质验收需求缺失；不能由子串检测直接推导缺上下文，更不能把 parent 原始字节保护与 child 语义上下文混为一谈。

需要：分开记录 verbatimOriginalIncluded 与 semanticCompleteness。非原样复制应标记需人工复核，不能自动宣称内容丢失，也不能自动宣称语义完整。无其他问题时使用 review_required 等明确状态；本次独立人工语义审阅结论为“核心要求已传递”。保留原协议结果/attempt/report 的 hash 及验证器版本，修正只重算协议/汇总并形成新审核记录，**不改冻结 prompt、原始任务、模型输入、评分或失败结果**。

## 后续放行与未验范围

P1/P2 修复后，可依据同一批已经完整保存的证据重新验收协议报告；不需要为了 Packaging 完成或 Cooper 官方全通过再试跑同题。修复前，本报告不放行正常 30 题单轮；修复通过后，当前模型失败本身不构成放行阻碍，最终应按后续独立验收结论推进。

本批未验证人工中断/runner 接续、网络提交意图不确定性对账、评分中断接续；不得把自然完成/截止取消当作受控恢复。独立
`recovery-dirty-001`
为另一实验，尚不计入本批分母或本次 PASS 子项。30 题单轮、正式多轮、模型服务身份的独立证明及完整资源 time-series 精度也均不在本次终验范围。

初验原始证据锚点（供协议报告修正后核对历史）：

| 文件                        | SHA256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| 001 protocol.json           | `c92f9c942386f6b8e2e7b8b2c1b7f93dcfd09c4af0aa4dc135a13ac7c9f64ea6` |
| 002 protocol.json           | `4091862f2a651413feef105b71680d08171fa27b4d4c8ffcdf2a82ed28455f91` |
| 001 scoring-001/score.json  | `058350e1f50f99a8626fe0c2770f2baa9edce4dfdab45b6144e3dc5ee2dfe7b8` |
| 002 scoring-001/score.json  | `51c4fa6546cafc40a85546bb8c79859fc03443b37d52fb398538fab0493835b0` |
| 001 trace-001/manifest.json | `fd0113a31ab100d9ad02e517ead89b5e8d4e8479ba27cbaa14661a063eeb836a` |
| 002 trace-001/manifest.json | `b5abee3902179d65b190fcc34e8a94ea2ff49ede3096d1c655871eaf13c41a34` |

## 第一次修复复验：P2 关闭，P1 仍有一个负例缺口

复验 v2 validator SHA 为
`11d8e911471f965e284b252d1574384552d38e6fce9165dea6c75e32afebd801`。验收方实际运行新增
`test_protocol_evidence.py`，**13 项通过**（关闭 Python bytecode/ pytest
cache 写入，仅使用临时 fixture，无模型/评分/容器动作）。

P2 修复通过：非原文子串分别记录 `verbatim=false`、
`semanticCompleteness=not_automatically_assessed`，其余自动检查通过时返回
`review_required`，不再自动断言需求丢失。scope 明确实质分工、集成/验证质量、上游限制和改写需求需要独立审核。本报告的逐项人工核对继续支持 002 核心要求语义已传递，保留机械待复核状态并不等于模型执行/benchmark 失败。

P1 的大部分修复核对通过：实际 child publish 输出、相同 revision fetch、server delivery
SHA/bytes/patch hash、parent 成功最终回复中的 child 身份和官方 child 评分引用建立关联；parent
publish 帮助调用不能冒充发布。001 保持 failed，新增 parent 未发布、无成功最终回复和未保留两 child 身份，issues 从 7 增至 10；002 为 review_required/0
issues，parent SHA 与两 child 评分 SHA 均对应此前实际证据。

但独立新增负例发现：**删除 parent/checkpoint.json、保留 published.json 后，v2 仍返回 passed/0
issues。** `latest_patch(..., preferred="checkpoint")`
会 fallback 到 published，因此实际上将 published 与自身比较，未证明最终采集内容一致。需要显式要求实际最终 checkpoint
metadata/file 存在并验证其 hash，不在此处回退到 published；补充缺失 checkpoint 回归。真实 pilot 的三个 parent/child
checkpoint 均存在且已核对一致，因此该缺口不要求重新模型执行或评分，但 P1 尚不能关闭。

修正审计 `runs/audits/pilot-protocol-validator-v2-1788953330157/result.json` 经独立全量 SHA 比较
**PASS**：before 309 文件、after
311 文件，差集恰好 6 个原协议/attempt/汇总文件修改和 2 个 protocol-v2.json 新增，无删除；其余
**303 文件 SHA 全部不变**。六个旧文件的 before-files 副本与 before
SHA 相符，两个原协议 SHA 等于上表初验锚点。actual after 与 after-sha256 全部一致。001
attempt 仅增加 protocolValidation，002 仅修改 childProtocol 并增加 protocolValidation；旧模型执行/评分/trace/analysis/cleanup 字段未变。来源源码 SHA、v2 输出 SHA、旧协议 SHA、审计路径及主 protocol 与 v2 字节一致性均通过。批次仍 complete、done=2、unscored=0，原始 benchmark 失败保持。

## 第二次修复复验：P1 关闭，阶段 3 最终 PASS

最终 validatorVersion=3，仓库源码与审计源码 SHA 均为
`81596dc5b3ef974ebe5be71583fb64fd5ef2dfd08d462201672c7e495cdd0663`。parent 检查现直接读取真实 checkpoint.json 和指定 patch，校验其 SHA；没有 checkpoint 时不再 fallback。另要求
`artifact-coverage.sessions[parent].finalCapture=true`，避免把旧的周期性 checkpoint 当最终采集。

验收方实际执行专项测试 **16/16 通过**，新增缺 checkpoint、非最终 capture、坏 checkpoint
SHA 三种负例均拒绝。另独立重做首次复验中未通过的 fixture：删除 parent
checkpoint、保留 published 后，结果为 failed，明确包含“Missing final parent checkpoint”和“Parent
publication does not match its final captured
code”，此前自比较漏洞已关闭。测试只使用临时 fixture，不接触真实模型或评分。

对本批真实数据，验收方在内存中拦截协议函数的唯一输出写入，进行**无落盘的只读重算**；两个结果分别逐对象等于实际保存的 protocol-v3.json：001
failed/10 issues，002 review_required/0
issues。两题 parent 实际 checkpoint 文件 SHA 与 coverage 引用相符，finalCapture 均 true；001 没有 published，继续明确失败；002
parent published SHA 等于最终 checkpoint，两个原 child
SHA 与官方 child 评分引用匹配。不以一个缺失对象的 fallback 或仅有 summary 字段代替此核对。

最终审计 `runs/audits/pilot-protocol-validator-v3-1788953572795/` 独立复核通过：

- before 311 文件、after 313 文件，精确修改两 attempt、两主 protocol、report.json 共
  **5 文件**，新增 **2 个 protocol-v3.json**，无删除；其余
  **306 文件 SHA 不变**。report.md 内容未变，因此不计入实际差集。
- before-files 旧版本 SHA 全部匹配，实际 after 文件与 after-sha256 全匹配；v2
  protocol 文件和前审计保留。再从首次 v2 修正前的清单核对，最初受保护的
  **303文件仍全部不变**，包括模型原始输出、prompt、评分、产物、trace、分析和清理证据。
- 两个 attempt 此轮只修改 protocolValidation，来源 validator SHA、当前 v3 输出 SHA、上代 protocol
  SHA 和审计路径都可追溯；主 protocol 与 v3 文件字节相同。批次仍 complete、planned/done=2、unscored=0，两个 benchmark 的整体成功数仍为 0。

P1/P2 均关闭，当前阶段没有 must-fix。002 的 `review_required`
是机械检查对改写需求保留的明确边界：本报告已经独立逐项确认 MAC/Email 的实质需求、分工、传输、集成验证和发布身份，不把它强行改成原文逐字复制，也不把语义审核当作官方正确性通过。001 的超时/协作失败和 002 的合并冲突/Email 官方失败继续作为有效实验结果。

**允许推进正常 30 题低并发单轮，不需要重新运行本两题来追求成功。** 该放行不包含尚未完成的受控恢复
`recovery-dirty-001`、30 题单轮本身或正式多轮结论；恢复实验和正常单轮结果必须分别落盘并独立验收。本次没有运行真实 resume、模型、评分、trace 导出或分析，只有代码/证据只读复核与临时 fixture 测试。
