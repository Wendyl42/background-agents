# 阶段 4：正常 30 题单轮独立验收 — FeatureBench

本文件只维护 FeatureBench 验收；CooperBench 与整批终验由其他验收记录负责。外部批次：`../benchmark-lab/runs/acceptance-30-001/`。验收仅读取落盘原始证据与宿主进程/容器状态，不修复实现或实验记录，不提交模型、不运行评分、不停止任何资源。

## 当前分题进度

截至 2026-09-09 13:28:34 UTC 的宿主核对，本文件独立验收了四个 FeatureBench attempt；整批仍 allocated
/
**PENDING**。下面分别保留每题的证据结论及模型真实结果，不据机器协议状态替代人工审核，也不把任一题的证据 PASS 写成 benchmark 成功。

| attempt          | 证据完整性                 | 模型执行               | 机器协议 / 完整附录人工审核                              | 官方结果                                                              |
| ---------------- | -------------------------- | ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| 001-01 Packaging | PASS                       | deadline               | failed / 未满足                                          | resolved=false，空补丁提前拒绝，测试未执行                            |
| 002-01 MLflow    | PASS                       | completed              | passed / **未满足，见下文具体指令遗漏**                  | resolved=false；F2P 53 通过、2 失败、1 跳过；P2P 84 通过              |
| 003-01 Meson     | PASS，结束时间字段缺失单列 | infrastructure_failure | failed / 未满足                                          | resolved=false，空补丁提前拒绝；观察超时导致提前取消，非自然 deadline |
| 004-01 Metaflow  | PASS                       | completed              | passed / **未满足：未指示 child 使用相同模型与推理设置** | resolved=true；F2P 31 通过、P2P 14 通过；6 条测试命令均 exit 0        |

## 001-01 Packaging 结论

**001-01
Packaging 的证据完整性：PASS。模型执行：deadline；child 协议：failed；官方正确性：resolved=false。整批 30 题验收：PENDING。**

本次复验于 2026-09-09 12:39:38
UTC 完成宿主只读核对。首题是真实失败观测，不能算作完成协议的合格 fan-out 样本，也不能删除、换成前一次 pilot 结果或重试到成功。当前没有发现要求重跑首题模型/评分的接入、评分或证据缺陷；可以继续已启动的原批次。余下 29 个 attempt、全部 FeatureBench 结果及批次分析仍须后续验收，本报告不提前放行阶段 4 全部完成。验收期间未干扰正在运行的 MLflow。

| 独立维度         | 首题实际结果                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| 模型执行         | 共用 1,800 秒 deadline；parent 与两个 child 均取消，没有成功最终回复                               |
| child 协议       | v3 failed，11 条自动问题；确有两个独立 child，但未完成发布、取回、交付、集成                       |
| benchmark 正确性 | 官方接受评分请求后因空候选补丁提前拒绝；resolved=false                                             |
| F2P / P2P        | **均为 0 观察、未执行测试**；两 success 标志为 false，不是实际测试均失败或通过                     |
| 最终产物         | parent 与 parser child 各 0 bytes；metadata child 19,478 bytes；三者均最终采集完整、均无 published |
| trace / 分析     | complete / complete；24 份 trace 文件与 14 份分析输出逐文件 SHA/bytes 通过                         |
| 基础设施 / 清理  | infrastructure=[]；cleanup complete；3 模型容器及 1 评分容器精确 ID 均已消失                       |

## 输入、版本及实际执行链

任务为 `pypa__packaging.013f3b03.test_metadata.e00b5801.lv1`，attempt
`001-01`，repetition=1。计划仍为 30，不因首题失败改变分母。配置 SHA256 为
`dbe590fed36ecbfb3d4af9f1f9653d4972d8fe7ba4ab3299275c47d3eca306b4`。批次配置、全部任务对象、套件锁、两份 benchmark 锁副本、冻结准备/镜像/校准证据的 hash 关联与 15 份 adapter-source/current
source 均相符；没有重跑已通过的 30 题校准。

实际原 prompt 为 43,336 bytes，SHA256
`edcbc8a3c7e2c4783f1a866612ddb4185d6c844eb3e28c9f4a909844dbc409c0`；附录 SHA 为
`5ef0aa1391c7ae42292be2f6dfcd877bb8923915477397b15309ab53bc0031a2`；submitted SHA 为
`bb92a335ef57e9fb52ca7f90e66e23fab192f4ff64eccf39bb3ab54b8669122a`。原文与冻结数据逐字节相等，submitted 等于原文及规定附录组合，prompt-manifest、API 根消息与 durable
user_message 内容一致。只有一次根 prompt 提交。

| 角色 / 实际分工                        | session ID                         | API message ID                     |
| -------------------------------------- | ---------------------------------- | ---------------------------------- |
| parent，统筹与集成                     | `a33ec886a9a04efbae7446b4eb6a5470` | `b0a2d76c7366d9a9200c54a05bf0356b` |
| child A，metadata.py                   | `c8fe04ebd1f743a296455b15b4db0f66` | `048cce7ee225d50cc80bb9b8714c414e` |
| child B，requirements.py / \_parser.py | `ebfa9ac8fa6123ae17ba18e39ddd62a4` | `a6fa8df3ede7c4fc4c4825a80cf37b57` |

API 树、两个成功 spawn 输出、事件、三个实际不同 sandbox/container/provider object/ startup
attempt 相互吻合，最大深度 1。每个 session 保存一次实际 runtime prompt.start，均为
`deepseek/deepseek-v4-flash`、reasoning=null；镜像与各自 2 CPU / 3
GB 配置一致。这是请求分发和真实工具执行证据，不是仅引用配置，也不证明服务商内部实现。

promptIntent 为 11:57:28.504 UTC，deadline 为 12:27:28.504 UTC；executionEnded 为 12:27:28.708
UTC。三条 execution_complete 均 success=false / Execution
cancelled，与 API 失败终态相符；这是固定时限结束，没有人为中断或恢复。

## 原始轨迹与失败原因

以下时间均相对 promptIntent。根模型先读取
`/opt/oi-benchmark/task.json`，得到workspacePath=`/testbed` 和清理后的唯一初始 commit
`1b1213bdbf5720b551372aad9ac9cd51f33d885a`。

| 时间               | 已保存的实际行为及含义                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| 18–52 秒           | 查看 `/testbed`、单提交 git 历史与被 mask 的 metadata/Requirement/parser；工作树干净                    |
| 231 秒             | 对尚未补全的可见 requirements 测试得到 5,287 失败；这是模型自行运行的可见测试，非官方结果               |
| 496.343 秒         | `git clone -q /testbed /tmp/exp`，从本地清理后的仓库建立临时副本                                        |
| 503–1,109 秒       | parent 的全部 18 次 edit、1 次 write 都写 `/tmp/exp/src/packaging/`，bash 也修改该临时副本              |
| 610.326 秒         | 明确设置 `PYTHONPATH=/tmp/exp/src` 在临时副本测试，requirements 5,287 passed；稍后支持模块 3,364 passed |
| 1,139.218 秒       | 把自己临时副本的三个文件复制为 `/tmp/ref_*.py`，并 py_compile；这些文件名不能证明取得外部参考解         |
| 1,164–1,166 秒     | `oi-bench --help`、list 返回空，以及 publish/fetch 帮助页；无实际发布或传输                             |
| 1,202.330 秒       | 成功创建 metadata child，距总截止只剩约 598 秒；父已先自行工作 20 分钟                                  |
| 1,220.255 秒       | 一次缺 title 的 spawn 返回 HTTP 400；明确未创建第三个 child，不是额外模型重试                           |
| 1,234.954 秒       | 成功创建 parser child，距总截止约 565 秒；之后才首次查询 child 状态                                     |
| 1,336 秒起         | 五次 get-child-status 都是 running，无 includeResponse 最终结果；间有长 sleep                           |
| 1,346 秒起         | parent 明示继续完善 scratch clone，继续临时副本边界测试；未取 child patch、未复制回 `/testbed`          |
| 1,725–1,796.559 秒 | metadata child 在自己的 `/testbed` 完成 11 次 edit，最后一笔距截止不足 4 秒                             |
| 1,800 秒           | 三会话按截止清理，未形成任何成功最终回复、主动 publication 或 parent 集成                               |

parser child 只有 read/grep/bash 共 29 次工具调用，没有代码编辑，最终工作区补丁为空。metadata
child 最终补丁只修改 `src/packaging/metadata.py`：增加 ExceptionGroup
fallback、RFC822、parse_email、验证器/字段处理及 Metadata.from_raw/from_email/as_rfc822；实际改动与分工一致，但未完成发布及最终验证。parent 的 scratch 代码和该 child 代码不是同一工作树，不应把临时副本可见测试通过或 child 的未发布代码替代 parent 官方候选。

空补丁有直接轨迹解释：parent 的实现留在
`/tmp/exp`，没有交付回指定 Git 工作树。不存在“模型已经在指定工作树完成，而最终 collector 漏采”的证据。提前完成 fan-out 或及时回填可能改变执行过程，但本验收不作反事实成功保证，也不要求重跑验证该猜想。

## 附录与可见性人工审核

两份成功 child prompt 明确互补职责、相关原始接口需求、独立
`/testbed`、同模型/推理、不再创建 child、禁止取上游/参考解/隐藏测试/装包、可见测试和发布 sessionId/SHA 要求。metadata 上下文覆盖邮件解析、字段验证、版本约束与序列化；parser 上下文覆盖 PEP
508 和 Requirement 接口。实质分工和相关核心需求上下文足够；FeatureBench 不要求每个 child 原样复制全部 parent
prompt，也不能据非逐字文本自动宣称需求丢失。

| 附录条件                                         | 独立判断                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| exactly two child、独立 sandbox、先创建两者再等  | 通过；3 次工具调用中仅 2 次创建成功，API 树恰好两直接 child                                                          |
| 实质互补分工、相同模型、禁止再分裂               | 指令及实际身份通过；无孙会话或进程内 Task 替代                                                                       |
| 读取 task.json 并在指定工作树保留实现            | parent 实际读取但实现留在 scratch；两 child prompt 给出正确路径，却未转达读取 task.json 要求，保存的工具中也无此读取 |
| child 完成实现/验证、publish 并回复身份          | 未完成；metadata 有代码，parser 无代码，均无 published 或成功最终回复                                                |
| includeResponse、按原 SHA fetch、服务端 delivery | 均无；帮助页/list 不算 fetch，两个 child 的文件存在不代表跨 sandbox 交付                                             |
| parent 检查/集成/验证后 publish、最终保留两身份  | 未完成；parent 最终工作区为空、没有成功最终回复                                                                      |
| 条件性 child 修订与再次 fetch                    | 无 send-child-prompt 或修订链，未实际演练                                                                            |

v3 的 11 条自动问题是：每个 child 各缺最终回复取回、发布、parent fetch、server
delivery（共 8 条），再加 parent 未发布、无成功最终回复、未保留两 child 身份（3 条）。人工确认这些都是真问题；task.json 指令遗漏、临时副本工作和验证质量属另外的语义审核范围，不因机械 issues 已列 11 条就说附录其余项全部通过。

可见性/上游限制单独核对，不能仅由 `find` 命令推测实际答案泄漏：

- parent 的 `git log --all` 只有隔离后的初始提交；`git clone /testbed`
  是本地复制，不是 clone 禁止的上游 URL。实现留在副本违反交付位置要求，已有独立结果。
- parent 搜索其他 metadata.py、packaging wheel/tar 和本地
  `*.patch`；实际输出没有取得未屏蔽 metadata 或参考补丁。metadata child 的同类搜索只返回当前
  `/testbed`。
- parser child 查找三处 pip vendor
  packaging，并读取/比较；目标三个 parser 函数计数均为 0，后续展示仍是 mask 后代码，仅保留 marker 部分。可见 vendor 路径不等于可见原始未屏蔽实现。
- parser 最后的全盘字符串 grep 在截止时仍 running，输出为空；不能断言它完成了全盘扫描，更不能凭搜索目标断言找到内容。没有观察到隐藏测试/参考解被读取或复制。
- parent 的 `/tmp/ref_*.py` 有明确从自己 `/tmp/exp` 复制的命令来源。评分日志中的
  `/tmp/test_patch.diff` 位于之后创建的官方评分容器，不能据此推定模型曾看到它。

这些搜索显示模型曾尝试寻找可复用实现，不能把上游限制行为无条件标为全面通过；现有保存输出没有成功获取答案的证据，也没有需修复的已证实答案暴露。已保存工具中没有远程 clone/fetch、curl/wget、安装包、push 或 PR 创建；该结论仅限可见轨迹，不等于完整网络审计或对所有可能读取行为的证明。

## 最终 checkpoint、官方评分与清理

三个 session 的 checkpoint.json、实际 patch 文件 SHA/bytes、artifact-coverage 一致，finalCapture 均 true。parent 与 parser 的 SHA 都为
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（0 bytes）；metadata 为
`e62ef8df727ec8a4dd58dd5a3ad51edf9bb42c6f68e1b42c8b7c1d07de34c5e8` （19,478
bytes）。三者 published 均 null；宿主 checkpoint 不冒充模型主动 publish。

独立检查原始 runtime 的 supervisor.shutdown_complete 与最终采集时间（毫秒）：

| 角色           | shutdown_complete | checkpoint.capturedAtMs |
| -------------- | ----------------- | ----------------------- |
| parent         | 1788956849732     | 1788956857633           |
| metadata child | 1788956849835     | 1788956855624           |
| parser child   | 1788956848999     | 1788956853626           |

三者都是停止后采集。`scoring-001/prediction.patch`
精确等于 parent 最终空补丁，prediction.json 的 model_patch 为空，n_attempt=1。官方版本为
`8d4e347ec57546685c5a87e8676bf575db022ea6`，数据版本
`76b4a4566e04f4bcc13c35125d4f301791efa736`，评分 adapter SHA
`521a1cb817fadd7062180c467bcd67f4f2ef79159804387e9ef18614a067e48c`。

实际 `run_instance.log` 中恢复项目与 mask 均 exit 0；20:29:46.044（UTC+8）在 Step 5 Applying agent
patch 后记录 `WARNING Empty patch provided`，随后退出。固定上游 `featurebench/harness/runtime.py`
在空 prediction 分支直接返回，不执行 F2P/P2P。官方 report 的 patch_exists/patch_successfully_applied/resolved 均 false，两类 tests_status 的 success/failure 列表全部为空；score 的 error=Empty
patch、testEvidencePresent=false、两 observedCount=0，且没有 test_output 或测试退出码。
**这是已完成评分的空答案提前拒绝；0 观察不是 F2P/P2P 的实际测试失败计数。** completion.json 与 score
SHA 对应，未用校准数据替代真实候选，也未对 child 单独评分。

cleanup 记录 cancelledSessions/removedContainers 与本题精确三 session/容器一致，remainingContainers=[]、errors=[]；评分容器也记录删除成功。12:39:38
UTC 宿主只读 `docker ps -aq --no-trunc` 核对以下 4 个完整 ID 全不存在：

```text
82f803369aea4b83e5cb2412744748472066c5cde1b6b4620f8f9bb91821df32
9ae125b8b27aabd705f4f4c3e8e737af2ef72cbb4a337fbcc3559f9e72dc1893
2139e112ffba20816d1a5652fedb26a42a5bb7c2c4d31081ca472895c7ee7c48
ba88ad57986f082d10b797790b9ec67610e7de96640d594e4713c174a6ea21f2
```

旧 collector PID 780370 / startTicks 3792375 对应进程也已退出；使用 PID
birth 而非单独 PID 判断，未对仍运行批次 runner 或其他题容器执行任何变更。

## Trace、审计工具及未验范围

原始三个 session 各有 1 页 event、1 页 message，末页 hasMore=false；event 分别 111/44/33，共 188，消息共 3；raw/normalized
ID 集合一致，无重复或漏页。176 个工具事件都纳入审阅。runtime 147 条、host
8,184 条附加记录与本树身份关联；24 份 trace 文件 hash/bytes 与 manifest 相符。analysis-001 的 14 份输出逐 hash 通过，profile=`block-d0-v1`、validation.valid=true、errors=[]、warnings=[]。

完整性范围是保存的 API 分页及文件完整；durable
upsert 不保留每个中间工具状态或逐 token 全流，个别大输出由 OpenCode 截断，host 为采样而非连续记录。分析有 3 次最终时间修正规则，不据此推导精确工具耗时；消息重叠不证明 shell 同时运行。批次未完成，其最终 trace-batch 输入覆盖、30 题分母终态和批量分析尚未验收。

只读审计入口：

```bash
python3 /tmp/benchmark-stage4-audit.py --run-id acceptance-30-001 \
  --expect-planned 30 --attempt 001-01 --current-source --live
```

独立执行修正版 SHA256
`24c28a6d6502d82ceef03c15c96bb09d9d392d3de28df616313469baeaa84fcc`：228 个批次检查、95 个首题检查全 PASS，sourceDrift=[]；首题 integrityStatus=PASS。整个脚本返回 exit
2 /
PENDING，是因为整批仍 allocated 且未全完成，不是首题证据失败。人工语义审核由本报告承担，没有把脚本的 manualReviewRequired 当作自动协议通过。

首次脚本 SHA `184499d73bbf264725add2e07804bcb7a77d8105a0b9b7b485922942777a46e5`
错误地从零 failure 推导两 success 应为 true，产生两条 false FAIL；原脚本保留为
`/tmp/benchmark-stage4-audit-v1.py`。修复只调整独立辅助检查：分开观察计数和官方命令退出码，Empty
patch 分支核对空预测、原 warning、没有测试记录及全部 false 标志；其他无退出码分支保留人工复核。独立阅读 diff、固定上游与实际日志确认该修复正确。原 adapter、模型、评分和证据未改写；下面 hash 在修复前后保持相同。

| 首题相对路径                      | SHA256                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| attempt.json                      | `0cc1a22fee602b85310c2ef76c6f44fc99562dda32e9151d3b8bda0779a011f9` |
| protocol.json                     | `158e630026913a003adee34183e79b68c9da8fb8a5ed8d4465a699905237d271` |
| scoring-001/score.json            | `d0a7c42d80c24318d1cb49dd7212e401e034aa2df4538ff696200d8ef712a56d` |
| scoring-001/official-report.json  | `68fa71769ce5a32f910c77734d126512b6b04dc8d12bd7d1c3435e164b885006` |
| scoring-001/run_instance.log      | `1330a0ac3bd394004217735a6afcd7508af18bd8ae0a67cc05c78dad9c161996` |
| trace-001/manifest.json           | `e3bf6a9e91abb74c55a42795fab8b138f3b9f6f9285dcf637e1f7d4e1b0a0299` |
| trace-001/normalized/events.jsonl | `bcd88e6232263db909569e7bc43b95e762c00b24c9e0f6f7d2ef46f9c7a83c78` |

本次未执行任何模型代码、pytest、官方评分或 resume；没有验证 scratch 实现的隐藏正确性、未重新构造丢失临时工作区、未对其他未完成 attempt 作终验，也未把此前独立 recovery 批次的结果混入本批。后续 FeatureBench 题完成后在本文件追加逐题结论。

## 002-01 MLflow 结论与范围

**证据完整性 PASS；模型 completed；机器协议 passed 原样保留；完整附录人工审核不通过；官方 resolved=false。**
发布、传输、集成及最终采集链通过。机器协议仅覆盖声明的自动检查范围，不能据此声称 parent 完整转达了附录或所有任务需求。

本题全部模型与官方评分均只执行一次；不修改冻结输入，不重跑到成功。没有发现需重跑的接入、官方评分或证据缺陷；可继续原批次。003
Meson 正常运行未被干扰，其余 28 个 attempt、全部 FeatureBench 和 30 题整批终验仍待后续。

### 版本、原始输入、工作区与真实会话

任务
`mlflow__mlflow.93dab383.test_client.42de781c.lv1`；基准/数据/adapter 版本与本批冻结配置一致，228 项批次检查通过、sourceDrift=[]。原 prompt 为 17,244
bytes，SHA
`a3a660584272141a884afd1e164c11a6c2c67ce2cf3627b6ad7f69d99240aa5c`；附录与 001 相同；submitted 为 19,657
bytes，SHA
`0a23a83d397bb5e6fdb59e55bee3f10e1021c35c21d49491328c149b778f5799`。冻结原文、附录、组合、prompt-manifest、唯一根 API 消息及 durable
user_message 逐字节一致。

| 角色（实际 spawn 顺序）          | session ID                         | 消息 ID                            |
| -------------------------------- | ---------------------------------- | ---------------------------------- |
| parent                           | `91d1f0949d8e963f1a891fb8303305ca` | `a46b556ba2730341cda8af8b4e903c15` |
| child 1，TelemetryClient / utils | `af4b715f9d7f07551c3584b12ccea113` | `99de87cbfb0c2313ee8ef7ee931ae560` |
| child 2，事件过滤 track.py       | `695bd981b8ea295469e946c4a5dceb42` | `5fd9feec8cbed9e4fb22803181b4cd9b` |

三个 session 各有一次实际 runtime prompt.start，均为 `deepseek/deepseek-v4-flash` /
reasoning=null，镜像及 2 CPU / 3,072 MiB 资源符合冻结配置，三容器/provider object/startup
attempt 不同。两次 spawn 都成功，无孙会话。三条 execution_complete 均 success=true，并与 API
completed/最终回复对应。从 promptIntent 到最后 parent
execution_complete 约 1,083.3 秒，未触及 1,800 秒截止。

parent 实际读取 task.json、git status/log；core child 也执行 git log/status，显示同一干净初始 commit
`f2fab66a98193efe3ef2a1f1fff23b373aab73f7`。两 child 初读的目标文件仍缺对应实现，未继承 parent 稍后的独立编辑。另只读打开冻结 workspace.tar 的三个目标文件，在内存中核对各最终 patch 的原文上下文并重建代码，未执行模型代码或创建工作区：全部补丁可精确对应同一准备起点。事件 child 没有自行运行 Git 起点核查，两 child 也没有实际读取 task.json；环境起点证据与模型是否执行要求分开记录。

### 分工、实际执行与附录人工结论

parent 在约 440.082 秒创建 core child，448.910 秒创建 filtering
child，632.131 秒才第一次查询状态，满足先创建两者再等结果。分工有明显大小差异：core 修改 client.py 和 utils.py，filtering 只增加 24 行的事件判断函数；后者仍是原始任务要求的独立接口，具有 no-client/config-pending/disabled-event/异常等实质行为，不是空 child。

core child 收到 14,415 bytes 上下文，事件 child 收到 5,924 bytes；均说明独立
`/testbed`、另一 child 所有文件、依赖接口、不可再创建 child、不可取上游历史/隐藏测试，并要求 commit 和实际 publish/返回身份。core 需求覆盖生命周期、批处理、异步配置、flush 与 config
URL；filtering 需求覆盖完整事件过滤优先级。

**人工未通过项必须保留：**

- 两个 child prompt 都没有“使用与 parent 相同 model 和 reasoning
  settings”的指令。实际分发设置相同已证实，但这不能代替附录要求的显式转达。
- 两个 prompt 只给出 task.json 位置，没有要求读取它；两 child 保存的工具轨迹也均无此读取。它们正确在
  `/testbed` 工作，不把这项指令遗漏歪曲成工作区真的错误。
- 原 prompt 要求 worker count 使用默认值且仍可运行时配置；parent 给 core 的具体指令简化为
  `MAX_WORKERS` 和直接 `range(MAX_WORKERS)`，省去该配置约束。原文没有指定 `_max_workers`
  私有字段名，因此不能说 parent 删除了原文中这个名字；但运行时配置要求没有充分保留，最终代码也未提供该字段，正对应官方两处失败。
- 两个 child
  prompt 没有完整转达“不 push/不建 PR”等附录禁令；实际保存调用没有 push/PR 操作。指令不完整与观察到禁止行为是不同结论。

不将上述遗漏改写成机器 false pass 缺陷：当前 validator
scope 已明确任务需求完整性、语义限制和实质分工需要人工审核。这里保留机器
`passed`，同时给完整附录人工 `未满足`；不能对本题发布“协议整体通过”的无条件结论。

parent 在 child 工作期间也独立实现三文件并测试，约 630.654 秒将自己的版本保存到 `parent-reference`
分支，再回初始 main；随后真实应用两 child
patch。内存重建最终代码证明：track.py、utils.py 与原 child 内容逐字节相同；client.py 仅比 core
child 少两行空白，Python
AST 相同。故最终确实使用了两 child 产物，没有把父自行实现的分支冒充协作交付。这段重复实现属于观察到的协调开销，不据消息时间推算 shell 并行率。

事件 child 用 fake client 检查各分支并完成 import；core 的可见 utils 2 项、events
36 项通过，track 因另一 child 接口尚缺先出现真实收集错误，之后用 `/tmp`
的临时进程内 shim 验证 8 项，并在最终回复明确披露。shim 不在 child 发布补丁中。parent 集成后真实运行未替换的 utils/track/events 得到 46
passed；完整可见 telemetry 运行得到 72 passed / 5 failed。五项原输出涉及缺 pyspark/openai、API
key 类型及 package
metadata，不能照抄 parent“全部只是可选依赖、确定预先存在”的断言；本验收没有在干净起点重跑该完整可见测试集。它们与实际官方两个
`_max_workers`
失败分开。部分 lint 工具检查报工具/配置问题，不能将最后模型的完成语气当作所有验证通过。

### 发布、最终回复与原 revision 交付

| 发布者          | SHA256                                                             | bytes  |
| --------------- | ------------------------------------------------------------------ | ------ |
| core child      | `2e4d99ef42112f80709ceab97d209962fa184be59caed4e20c92fd24f4c8c01b` | 13,337 |
| filtering child | `814d8237e0bb235386dbf7c32dddfea3187a905a823ade9f6574a45d0203fbec` | 1,481  |
| parent 集成     | `abb275674fd855d5764c64d90a970eaec11184f8f70e9ab3373cebee8f919464` | 14,884 |

三份实际 publish 工具输出与 published
metadata、patch 文件 hash/bytes、各成功最终回复一致；三份 publication 均精确等于最终 checkpoint，并非只看到帮助页。parent 对两个具体 child 分别以 includeResponse=true 取得 DONE
/ Success yes
/ 最终身份；使用各原 SHA 的实际 fetch 命令读取补丁。服务端 delivery 精确对应同一 recipient
parent、source child、SHA 及 1,481/13,337
bytes，sentAtMs 分别为 1788957631469、1788957856575。parent 随后检查和实际
`git apply --check && git apply` 两份补丁成功；没有把 message 文本当作已经传输的代码。

parent 最后 46 项测试在 publish 之前；真实 publish 记录时间 1788958071609，成功最终回复 1788958078928，回复准确保留两原 child 身份和 parent 自己的身份。三份最终 capture 均在相应 supervisor.shutdown_complete 之后：

| 角色            | shutdown_complete | checkpoint.capturedAtMs |
| --------------- | ----------------- | ----------------------- |
| filtering child | 1788958082203     | 1788958097335           |
| core child      | 1788958083183     | 1788958109204           |
| parent          | 1788958084199     | 1788958122110           |

artifactCoverage 三项 finalCapture=true、status=complete。FeatureBench 此处官方评分只使用 parent 最终集成补丁，未给两 child 各自官方分数；不能声称原 child 官方也通过。

### 可见性与上游限制

parent 查找其他 telemetry/client.py、MLflow
wheel/安装目录，没有获得另一份未 mask 实现；初始 Git 仅一个清理后提交，`git fsck --lost-found`
没有输出可恢复历史对象。它确实读取了本地生成的 client.pyc 的方法名，返回只有
`_process_records`、`_consumer`、is_active、`_update_backend_store`
等原先可见方法，没有缺失 constructor/activate 等。不能把访问 pyc 本身推定为已恢复答案。`parent-reference`
分支有明确自行编辑来源。

本题**存在实际网络 GET**：parent 在约 302.677 秒请求公开遥测配置端点
`https://config.mlflow-telemetry.io/3.0.0.json`，得到 403 AccessDenied
XML。这与任务功能相关，不是原 prompt 禁止的 GitHub 仓库 URL，也没有返回参考解、历史或隐藏测试。保存调用无远程 Git
fetch/clone、装包、push/PR；不写成“没有网络访问”，也不把接口访问失败解释为评分基础设施故障。现有证据未显示成功取得被禁止答案，但这不等于完整网络审计；没有为证明不存在泄漏重启 sandbox。

### 官方失败、完整日志与辅助脚本计数复验

scoring-001 的 prediction
SHA 精确等于 parent 上表最终 checkpoint，patch_applied=true，testEvidencePresent=true、error=null。固定上游的真实 F2P 命令 exit
1，五条 P2P 命令 exit 0；official-report 与 score 的 resolved=false / f2p_success=false /
p2p_success=true 一致，completion 记录的 score SHA 匹配。

两个官方失败都是 AttributeError：`test_telemetry_client_initialization` 读取
`_max_workers == MAX_WORKERS`，`test_max_workers_setup` 读取
`_max_workers == 8`。最终 parent 和原 core child 均未初始化
`_max_workers`，activate 直接使用常量。其余 F2P 为 53 passed，并有 1 个 Windows-only
skipped；P2P 各文件 13+14+29+14+14=84 全通过。这是正常评分产生的真实模型功能缺失，不能归因于接入故障。

只读调用固定上游的 MLflow log
parser 解析已有六份输出（禁止 bytecode 写入、没有执行 tests/评分容器或改结果），并逐条比较 official-report 列表：F2P
53 PASSED、2 FAILED、1 SKIPPED 共 56 观察，P2P 84 PASSED；四个 success/failure 身份列表完全一致。原
`SKIPPED [1] ...:662: This test only passes on Windows`
可直接定位。上游默认 PASS_AND_FAIL 分类省略 SKIPPED，所以官方两列表共 55 与 observedCount=56 同时正确，不能把差一条当作日志缺失，也不能普遍把所有差额自动解释为 skipped。

helper
v2 在这里错误要求 55=56，独立初验得到 1 条辅助误报，其余 228 个批次检查和 103 个本题检查通过。实施方仅修辅助工具为下界检查，记录精确差额并强制人工复核。本次独立读 diff 后，于 12:57:46
UTC 宿主执行 helper v3，SHA
`049ec8798f4b9cd64451fcdc0a6515a3962ee4383d791e5ff2f32033582341b1`，相同入口改为
`--attempt 002-01`：228 批次 / 104 本题检查全 PASS；F2P
unclassified=1、P2P=0 和 manualReview 明确保留；整批 exit 2 /
PENDING。差额由上述原日志/parser 独立关闭，完整附录的人工未通过结论仍保留。原 v2 为
`/tmp/benchmark-stage4-audit-v2.py`。001 的此前工具修正另归档于
`runs/audits/stage4-auditor-v2-1788957464679/`；真实模型、评分、输入、失败结果不因辅助脚本修正而变更。

### Trace、资源及证据锚点

三个 session 各 1 页 event 和 message，末页无后续；event 分别 84/51/11，共 146，其中 134 个工具事件，3 条消息，raw/normalized 身份完整一致。24 份 trace 文件与 14 份分析输出 hash/bytes 通过；block-d0-v1
validation.valid=true、errors/warnings 均空。上文 001 的持久化 upsert、输出截断、host 采样与语义分析限制同样适用。

cleanup complete、remainingContainers=[]、errors=[]；3 个模型容器及官方评分容器在 12:57:46
UTC 宿主只读精确核对全部消失：

```text
4182c2826e30549720923c0f7a9acd1391cfe00638d76e084e9de6d08b93d5ec
e6bf0cbf1e63ab2ee6941dfe03dba7d9ce01747672b3f6b8d15b2534df1eb484
b9480f8c90a158e2b0fad75aaa1247f66c5e2a79fbfbe848ef9783adad8e07c1
2b969cc303c6506d68acf17c7b916dfb5ffb7d0911b4e4a36692656106c57459
```

旧 collector PID 856914 / startTicks
3987098 已退出；未清理或操作其他任务。主要证据 SHA 在两版辅助检查前后保持不变：

| 002-01 相对路径                   | SHA256                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| attempt.json                      | `5f3ff3c69422720847e5dac15a56072b5218569ccd2dc03df50b125da3a2c05d` |
| protocol.json                     | `f75153c83dffd9dc72fab559d116811ff5a91284c6ff3d29e5c86ff548d1dc49` |
| scoring-001/score.json            | `af59998c161656da2c0ceac695231567760afbd4640ff83797750bed3d49e5a0` |
| scoring-001/official-report.json  | `9e5f9c7873e9149d9d1625da4974da4f9e47e93c8deeb5d1855d702519a78385` |
| scoring-001/run_instance.log      | `b319708050854152774851af44f6c8cd37f06a030c76993b184fffcfdafad6e3` |
| scoring-001/test_output.txt       | `980bbd612156597eab811553bed8269c9b63d15a545a4806ce3a371b562f13bb` |
| trace-001/manifest.json           | `869064fbe31d9570cdca176b1f660460545958678887e008f509de4a02d3728d` |
| trace-001/normalized/events.jsonl | `8c31a2995c55440abfb1abd3ab3d2a7fb5245fb91c1d90b468d31394e11b4ea2` |

没有实际执行新的模型、测试、评分或恢复，未把原 parser 的离线读取称为重跑评分。本题证据 PASS 与模型失败、完整附录未满足可同时成立；继续保留全部计划失败分母。

## 003-01 Meson：观察超时后提前取消

**终态证据完整性 PASS（保留 executionEndedAtMs 缺失）；实际执行为 infrastructure_failure，infrastructure=["timed
out"]；协议 failed；官方 resolved=false。**
这不是模型用满 1,800 秒仍未完成的结果，更不是正常完成的 fan-out 样本。一名 child 已经完成并发布，parent 与另一 child 被观察故障后的取消提前结束。该失败保留在 30 题分母，不重跑模型或评分来替换。004
Metaflow 未受本次只读审阅干扰，整批仍 PENDING。

### 输入、身份与时间边界

任务 `mesonbuild__meson.f5d81d07.cargotests.8e49c2d0.lv1`，attempt
`003-01`。冻结配置/版本/输入与当前源码 228 项检查通过，sourceDrift=[]；原 prompt 23,260 bytes，SHA
`f271c58da81094b3368cfc061461831196763b5d5acc657336b82ae5f938dc70`；附录同前，实际 submitted 25,673
bytes，SHA
`43f420c00ddead0ea480f2c995452e86bf3f47dd510eaeac6b4c22d8b0a03a82`。固定原文/附录组合、manifest 和实际唯一根 API 消息逐字节对应。

| 角色（实际 spawn 顺序）       | session ID                         | message ID                         |
| ----------------------------- | ---------------------------------- | ---------------------------------- |
| parent                        | `f2ef5bb96f2dd3ed7504f13a5836972e` | `09ff532adf2d68f818ce003fe9fd6860` |
| child 1，cfg/toml/version     | `d99834092fc5f6f8150ebad27b065929` | `bb468fd60d18bc3253835565abcca4f5` |
| child 2，manifest/interpreter | `b03214a670fc58ce7d18b73a8fc71a24` | `a203110dd6784f87b07e5cb89185acdb` |

sessionTree 的存储顺序不代表 spawn 顺序。两次真实 spawn、API 树和不同 sandbox/
container/provider/startup 身份对应；三个 session 各一次实际 prompt.start，模型均为
`deepseek/deepseek-v4-flash`，reasoning=null，冻结镜像及 2 CPU / 3,072 MiB 一致。

| 已有时间字段或事件（UTC） | 含义                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| 12:52:50.173              | promptIntentAtMs=1788958370173                                     |
| 13:01:53.641              | lastObservedAtMs=1788958913641，最后成功观察时间，不是模型结束时间 |
| 13:01:58.431              | child 1 实际 publish，发生在最后成功观察之后                       |
| 13:02:00.987              | child 1 的 execution_complete success=true                         |
| 13:02:25.753 / 25.793     | parent / child 2 的取消 execution_complete，success=false          |
| 13:22:50.173              | 原定 deadlineAtMs=1788960170173，未用满                            |

attempt.json
**没有 executionEndedAtMs**，本验收没有补写或推测一个 modelEnded 时间；事件中的取消时间可界定终止动作，不能替代缺失的 runner 字段。父最后
`sleep 90` 工具在持久化记录仍为 running，不能据其命令时长声称睡满 90 秒。

独立只读核对 `control-plane/service.log`：root 的 children GET 有 Wrangler
`200 OK (30065ms)`，同窗口两条 router 记录 duration_ms=43/44（ts=1788958945710/5711）。随后 root/child
2 cancel 返回 200；已经完成的 child 1 cancel 返回 409。这与自动提前取消及 child
1 已完成相符，cleanup 的 cancelledSessions 列表不意味着三模型都因取消失败。观察受阻期间 child 仍能发布/完成；不据此宣称整个 CP 冻结、OOM 或已确定某个底层调度根因。入口延迟诊断及其尚未确定的原因由
[阶段验收](STAGE_REVIEWS.md) 的独立诊断记录负责；本次没有热改运行源码。

### 实际分工、工作区与产物

parent 读取 task.json、git status/log，显示 `/testbed` 干净、唯一初始提交
`5b89f74…`。随后阅读 Cargo 源码、Rust 可见 fixture、wrap 结构及辅助工具，约 497.867 秒才创建 child
1、522.237 秒创建 child 2。两份 prompt 分别为 12,192 / 17,088
bytes，覆盖互补工作：前者实现 version.api/convert、cfg.parse/eval_cfg、toml.load_toml；后者实现五个 manifest 属性/方法与 lockfile/wrap 解析及相关 helper。需要另一组尚不存在函数的验证用
`/tmp` shim 明确隔离，子任务上下文足以识别依赖边界。

两 prompt 均给出 workspace/task.json 位置、禁止上游/参考解/隐藏测试、同模型/推理、不再分裂、不装包、不 push/PR、指定文件范围、实际 publish/返回身份。原始核心接口与两组职责相符；其中 parent 自行给出名为“Reference
implementation”的具体建议代码，不能仅凭标题推定取得外部参考解，也不把这些建议当作官方正确实现。两 prompt 均未显式要求读取 task.json：child
2 自行读取了它，child 1 未观察到读取；不能把路径已传递写成全部附录指令已执行。

child 1 实际在自己 `/testbed/mesonbuild/cargo/` 修改三个文件，以 `/tmp`
脚本进行 API/version/cfg/TOML 与不存在文件异常检查，原工具输出
`version OK / cfg OK / toml OK`，随后成功 publish 并返回完整身份。最终代码确含上述函数；这些自建断言通过不等于官方 Cargo 隐藏测试通过，本题没有对该 child 单独评分。

child
2 在取消前读取 task.json、manifest/interpreter 及未实现的 version/toml，随后两次 edit 记录为 error，output 为空。原因没有保存在这两个工具输出中，不推断是匹配错误、权限故障或取消造成。其 token“Now
let me make the manifest.py edits”是中途说明，不是成功最终回复；最终 Git
checkpoint 为空，与没有成功写入的轨迹一致。

parent 仅写 `/tmp/opencode/validate_cargo.py`
准备集成断言，没有在目标工作树留下实现，也未实际运行该验证脚本。保存轨迹没有 get-child-status/includeResponse、实际 fetch 或 server
delivery，没有将 child
1 的成功产物取回。父最终空补丁有工作区和轨迹双重支持，不能归因为 collector 漏采。

| 角色    | published / 最终 checkpoint                                                           | bytes |
| ------- | ------------------------------------------------------------------------------------- | ----- |
| child 1 | 两者相同：`a2db15a3bfa56f3006b646457ff47a803795c7c632a7cf7613bca1e449b6b528`          | 7,818 |
| child 2 | 无 published；最终 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 0     |
| parent  | 无 published；最终同上空 SHA                                                          | 0     |

child 1 的真实 publish 输出、metadata、实际 patch
hash/bytes、成功最终回复与最终 checkpoint 全部相符，仅修改 cfg.py/toml.py/version.py。机器协议的 10 条失败均真实：child
2 缺发布/最终取回/fetch/delivery，child
1 缺最终取回/fetch/delivery，再加 parent 缺发布/成功最终回复/两 child 身份。恰好两独立 child 与实质分工存在，但交付闭环未完成。不把基础设施中断下的未完成项写成“模型在完整预算内主动放弃协作”。

可见工具中 parent 搜索 `/testbed` 以外的 cargotests.py，没有返回隐藏文件；读取
`/opt/oi-benchmark/artifacts.py`
得到的是产物工具实现，不是评分答案。其他文件读取是已暴露的源码和 Rust
fixtures；保存调用没有上游网络 fetch/clone、安装或 push/PR。这仍只是已保存轨迹范围内没有成功获取禁止内容的证据，不是全面网络审计。

### 官方早退、停止后采集与资源清理

三 session 的 finalCapture=true；分别核对原 supervisor.shutdown_complete 与最终 checkpoint
capture（毫秒）：child 2 为 1788958945943 < 1788958952530，child 1 为 1788958947028 <
1788958956701，parent 为 1788958946556 <
1788958960894。全部停止后采集完整；其中成功 child 的 publication 没有被后续清理覆盖。

scoring-001 的 prediction.patch 精确等于 parent 最终空补丁，n_attempt=1。官方日志恢复项目与 mask 均 exit
0，之后在 21:04:45.131（UTC+8）Step 5 记录 `WARNING Empty patch provided`
并早退。patch_applied=false、resolved=false、f2p_success=false、p2p_success=false；两类测试各 0 观察，无测试退出码、无 test_output，testEvidencePresent=false。不是测试实际全失败，也不是正常完成模型解答的官方分数。completion 与 score 的 hash 一致，评分状态 scored，未换用 child
1 补丁改善结果。

13:07:13 UTC 宿主只读 helper v3（SHA
`049ec879…82341b1`）检查 228 个批次项及 97 个本题项全部 PASS，whole PENDING / exit
2，manualReview 保留。旧 collector PID 914557 / startTicks 4124543 已退出；cleanup
complete、remainingContainers=[]、errors=[]；以下 3 个模型与 1 个评分容器精确 ID 均不再存在：

```text
010b8bc84df7ae8a22997e4493838690225cf225d550262e3ef703ce70fc46f3
c3e9ad2e2f9036334574cbba71b65079d9185bf29e02b6f05daa6c41294aa1f3
cd0f7b87679107c0ea7f2d88fe2267f349d05485d53bded7fe88d2e54d0e77a2
3d523d74bf24458d8704c4152179977eca1933be8042ac6898a30ecdeaad0da2
```

### 证据完整性范围与锚点

原始三 session 各 1 页 events/messages、末页 hasMore=false；parent/child 1/child
2 分别 44/17/11 个事件，共 72，其中 61 个工具调用、3 条 API 消息。API/normalized 身份与分页完整相符；24 份 trace 文件、14 份分析输出 SHA/bytes 全通过，分析 block-d0-v1
validation.valid=true，errors/warnings 均空。完成 trace 导出不表示 executionEndedAtMs 已有值，也不表示整个观察过程没有超时或逐 token 流被完整保留。

| 003-01 相对路径                   | SHA256                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| attempt.json                      | `992ede644faf21cb6ecc1c0ebdffaa5497e4de81c9b15646ec05f139acd3bfee` |
| protocol.json                     | `79c8ead1f8fbf72fb3ef2a66705b3afd428b276edd722ae592ece6af38359e56` |
| scoring-001/score.json            | `e56215d58eb4c63b7116f17c30f8502df461f0dec0c1ccf9c358afcc3a8c1648` |
| scoring-001/official-report.json  | `29e73c5623b579b37ce1277b96819d1c12c91115e74537f07292742e39cb9a8d` |
| scoring-001/run_instance.log      | `061355c5d088d7e771a89bd68f43fbbe0b42ae16d407c9691961a348924ee6a3` |
| trace-001/manifest.json           | `5a5bcdea503b59b6203affd737d3c7900f62af7747fc9905c71dbb3e47b4fbfa` |
| trace-001/normalized/events.jsonl | `9a9ccf1e7724b4ac0aba8e06f90ac1ab716b69bb48138791a4c6bea900ba2bbe` |

本次不修复或重跑。本题保留了接入观察故障及未完成代码这一真实状态；是否及如何改进观察超时处理属于后续实现决策，不能通过覆盖本次失败或修改冻结协议解决。本报告只验当前产物和可证明的时间边界，不把未知故障根因说成已排除。

## 004-01 Metaflow 结论

**证据完整性 PASS；模型 completed；机器协议 v3
passed；完整附录人工审核未满足；官方 resolved=true。**
官方成功是原始父集成补丁的真实测试结果；人工附录遗漏为两份 child
prompt 均未明确要求使用与父相同的模型和推理设置，实际三 session 配置一致。保留这两个不同维度，不修改官方分数或机器协议记录，不重试该题。整批 30 题仍 PENDING。

| 独立维度            | 004-01 实际结果                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| 模型执行            | 三 session 自然成功完成；runner 模型阶段 1,180.839 秒，未触及共用 1,800 秒 deadline                    |
| 分工 / 起点         | 两个独立容器，A/B 状态与注解、C/D 函数与类生成；两 child 实际读取 task.json 并检查相同干净 base        |
| 传输 / 集成         | 三次真实 publish；两次父 fetch 与服务端 delivery 精确匹配；最终响应保留两 child 身份；父有实际集成修复 |
| 完整附录            | 功能上下文与主要工作区、禁止上游、发布指令已传递；相同模型/推理设置的指令遗漏，不能判完整附录通过      |
| 官方正确性          | scored、patch_applied=true、resolved=true、F2P/P2P success=true、error=null；评分 9.686 秒             |
| 原始测试            | F2P 31 PASSED；P2P 14 PASSED；6 条命令 exit 0；无未分类观察差额                                        |
| trace / 分析 / 产物 | complete；24 份 trace、14 份分析 SHA/bytes 全通过；三最终 checkpoint 与 published 完全相同             |
| 基础设施 / 清理     | infrastructure=[]；cleanup complete，无剩余容器或错误；旧 collector 及四个精确容器身份已消失           |

### 输入与独立身份

任务为
`Netflix__metaflow.b390a8d4.test_stub_generator.7bf08c98.lv1`，repetition=1。冻结 FeatureBench
source 为 `8d4e347ec57546685c5a87e8676bf575db022ea6`，dataset 为
`76b4a4566e04f4bcc13c35125d4f301791efa736`。本次 helper 检查全部 30 项冻结关联与 15 份当前源码快照均一致，sourceDrift=[]；没有重新校准。

原 prompt 13,352 bytes，SHA
`c29fb5eaeaad2912131fd974cfb9a1da237584bb50d1e98411f9299f7eff6983`；submitted 15,765 bytes，SHA
`825a0b7ba8edc349efa307acae96d0140b6892108b4d92983070dc5df0affce9`。原文逐字节等于冻结任务文本，提交为原文加同一协议附录；API 根消息与 normalized
user_message 内容一致，仅一次根 prompt。实际 runtime 的三条 prompt.start 均为
`deepseek/deepseek-v4-flash`、reasoning_effort=null，分别关联下列真实 API message。

| 角色         | session ID                         | message ID                         |
| ------------ | ---------------------------------- | ---------------------------------- |
| parent       | `d8bec07b9118a7bebb8b73ee391b0914` | `ab41afcdfa26cef1631ccbbcdf66bf5e` |
| child 1：A/B | `137756dab270600a03f2672b12f68e44` | `2159291f85a0cdf9043ddd015c1a7219` |
| child 2：C/D | `dac353e5ce13d5acdc06d6e66626be62` | `e451287fc6c0629a393c312d18e802f5` |

原要求为同一文件 `metaflow/cmd/develop/stub_generator.py` 的四个方法。child 1 负责 `_reset` 与
`_exploit_annotation`，child 2 负责 `_generate_function_stub` 与
`_generate_class_stub`，是互补实现分工。两份实际 prompt 分别 13,354 / 25,005
bytes；独立抽取原题 docstring，确认各自负责方法的完整 docstring 原文均出现在相应 child
prompt 中。父还提供现有 helper、状态字段、接口依赖及不同插入锚点；C/D 使用临时 A/B
monkeypatch 做局部验证，并明确不得把它们加入自身补丁。这没有缩减四个原方法的功能要求。

两 child 都被指示读取 `/opt/oi-benchmark/task.json`，实际也读取了；随后 git 状态为空且历史起点为
`7e296e787419877f2a7c9c22c18bbe19835a7fe3`，A/B 额外检查两个方法尚不存在，C/D 在首次修改前同样检查 base 与 clean
status。父亦读取 task.json、检查该 base；三者独立容器和记录的资源限制一致（2 CPU、3,072 MiB）。

两份 prompt 都明确禁止再创建 child、上游/参考/隐藏测试获取、安装依赖、push/PR，明确仅修改指定 Git 文件并 publish 后回复 sessionId/SHA。但两份 spawn
args 都只有 title/prompt，正文均没有 same
model 或 reasoning 设置指令，也没有等价表述。实际继承到相同配置不补全该明确指令要求，因此完整附录仍未满足。未发生修订 child 或交付被忽略的新文件，send-child-prompt 与显式添加此类文件的条件分支没有实际验证。

### 时间、代码传输与父集成

以 promptIntentAtMs=1788959095106 为相对起点，父在 466.400 /
504.107 秒发起两次 spawn，第一次等待/查询 child 为 760.483 秒，两 child 均在等待前创建。不是立即分派，但没有先等待一位再创建另一位。A/B 在 557.862 秒成功结束，C/D 在 995.469 秒成功结束。父 execution_complete 为 1788960272228；runner
executionEndedAtMs=1788960275945（1,180.839 秒），两种时间含义没有混用。

父曾在 `/tmp/stubwork`
编写和测试自己的完整草稿，704.917 秒复制进工作树；收到 A/B 结果后，在 768.713 秒以 git
checkout 将该文件恢复 base，再 git apply --check /
apply 真实 A/B 补丁。C/D 完成后，父查询 includeResponse、fetch、读取文件，1,028.676 秒 apply
--check 成功，1,031.132 秒应用其原补丁。因此最终产物包含真正取回的 child 代码；不能仅凭父先前的草稿推断 child 交付被弃用。

| 真实 publication / 最终 checkpoint | bytes  | SHA256                                                             |
| ---------------------------------- | ------ | ------------------------------------------------------------------ |
| child 1 A/B                        | 3,962  | `d9a83aa06c739ded8baf15d00749c3d2720652db6fdad388a68752ed32e05ff5` |
| child 2 C/D                        | 21,183 | `619d7a0d96c014fa923e031475390566efba422fc6ba58352bd80dd2e2251de7` |
| parent                             | 25,445 | `8704507df8d9af9974da21f476c6f9666ae9283b48d314a7987fa0e8379ddda5` |

两条实际父命令均为
`oi-bench fetch <完整 child ID> <该 SHA> --output /tmp/child-<完整 child ID>.patch`；服务端 delivery 在 1788959859403
/
1788960101364 记录相同 source、recipient、SHA、bytes，落盘传输文件 hash 相同。父分别读取两个文件并应用；三次 publish 都是工具成功输出而非 help 文本。父成功最终回复 1788960272103 保留两 child
ID/SHA，并报告自身发布身份；官方 prediction 只使用上述 parent 最终补丁，未用 child 补丁替代。

只在内存从冻结 workspace.tar 重建三个补丁对应源码，未运行其代码。三份均是同一目标文件且 Python
AST 可解析；父 `_reset` / `_exploit_annotation` 与 child 1 逐源码一致。在 child
2 基础上，父增加 ast.literal_eval 检查无法表达的默认值，改用类自身 docstring，并为无成员的空类补
`...`。这些修改与工具轨迹中先发现空类语法错误、再修复并重验的顺序一致。最终 patch 不是父的早期草稿，也不是机械拼接。

轨迹中各 child 均运行自写 scratch 验证，C/D 的局部验证隔离未实现的 A/B；父整合后运行语法、注解、函数/类与完整 write_out 检查，最终一次记录
`files: 162 bad: 0`。这些是模型自身可见验证，官方测试成功另由评分容器原日志确认，不能混为同一证据。父 publish 后无进一步代码变化：published、显式最终 checkpoint 与实际 patch
SHA 三者一致。没有修订重发或第二次官方评分。

### 可见性及官方原日志

185 个 API 事件中有 173 个工具调用，均纳入审阅。父查找本地 stub_generator、缓存/其他环境安装位置；child
C/D 也查找工作树外同名文件，所见没有额外参考实现。父 `/tmp/stubwork`
和用于比较的临时“reference”对象可从此前自身写入轨迹溯源，不能据名称推断泄漏。工具记录未显示实际执行禁止 URL 获取、网络 git、依赖安装、push/PR 或隐藏测试读取。该结论限于保存的可见轨迹，不声称证明不可见网络行为不存在。

scoring-001 的 prediction.patch 精确等于父 25,445-byte
checkpoint，n_attempt=1。官方原 run_instance.log 在恢复、mask、候选应用、测试恢复各步骤均记录 exit
0。F2P 命令于 21:26:54.286（UTC+8）记录 exit 0；五条 P2P 命令于 21:26:55.007 / 55.687 / 56.407 /
57.093 / 57.741 记录 exit 0。测试输出实际存在。

用固定上游 source 的 `MAP_REPO_TO_PARSER.get("Netflix/metaflow", parse_log_pytest)`
只重解析六份原始 test_output，未调用模型、评分器或测试命令。F2P
`test/cmd/develop/test_stub_generator.py` 为 31
PASSED；P2P 中 argo_workflows_cli 为 8、pypi_parsers 为 3、multicore_utils / local_metadata_provider
/ pypi_decorator 各 1，合计 14
PASSED。所有 F2P/P2P 成功、失败身份列表与官方报告四列表精确相等；没有 SKIPPED 或其他未分类差额。两 success 与实际退出码、解析观察相符。

### 终态采集、清理及证据锚点

三 session 各有一页 events/messages，末页 hasMore=false；parent / A/B / C/D 分别 116 / 16 /
53 个事件，共 185，三条 API 消息。trace 24 文件与 analysis 14 文件逐 SHA/bytes 完整；block-d0-v1
validation.valid=true，无 errors/warnings。这确认保存的 API 分页范围完整，不将 attached 日志自动说成无缺口的逐 token 覆盖。

实际 supervisor.shutdown_complete 早于各最终 checkpoint（毫秒）：C/D 为 1788960276168 <
1788960281619，A/B 为 1788960277171 < 1788960284117，parent 为 1788960278064 <
1788960286560；artifact-coverage 三 finalCapture=true。停止后 capture 的 patch 与各先前 publish 的 SHA/bytes 相同，未以旧缓存代替终态。

13:28:34.478 UTC 的宿主只读 helper v3（SHA
`049ec879…82341b1`）中 228 个批次项和 104 个本题项均 PASS，whole=PENDING / exit
2，完整附录仍需人工审阅。旧 collector PID 940533 / startTicks
4197036 已退出；以下精确三模型和一评分容器均已消失：

```text
a32b1a64dd4d40ab83748a4e49d9559892bd84eb57333ea9dca0d5126c225449
69a50cb22f0f2437362db796cad0aa3ba3d1512f18d7db215b55246eb6f651e9
7af9ec85c2c91ef32d1f4c42658097f89612a8cacef4538b2b3950458eddd2e5
e4a0d0dbae68d447ea7c91f763aa1ebe6f2f4a6f78e8d7b67e04a1fbae6cadd9
```

| 004-01 相对路径                   | SHA256                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| attempt.json                      | `a60aec397255d54a7ef5124430c6fc64ec99e2354ea0a90ce49bc6eb91e553c0` |
| protocol.json                     | `e5fdbfdee820fd6aee4968b8242ef5573df397b9c19a3c7658c03094150f0015` |
| scoring-001/score.json            | `acf40318ee9a9fc49200965c1b9ffca25d935b73667a5014f95bc76fb809e9d9` |
| scoring-001/official-report.json  | `648a94e5947a903bce2466bfd698ad3b50ca8ac54592118459fe900a1f6beca9` |
| scoring-001/run_instance.log      | `e963fa30309f2b4d6f525b58b2a0dafe63d32d17ac17a2dc0e072fa890340d6c` |
| trace-001/manifest.json           | `03b0cbe15a95217f8880d1397ea840642561ca0419f22027acf0b4cc24dcf028` |
| trace-001/normalized/events.jsonl | `08432f9207dc432e9aa15735598de47d7f29bbe4b29ce90b48a1599a94586232` |

本题没有发现必须修复接入、评分或证据后才能继续原批次的缺陷。完整附录指令遗漏保留为本次模型协议观测，不能靠修改冻结 prompt 或重跑到合格来覆盖。验收不干扰正在运行的 005
Pandas；余下分题和整批分析尚未完成，不据本题官方成功提前结束阶段 4。
