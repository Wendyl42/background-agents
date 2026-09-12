# Benchmark 阶段独立验收

验收日期：2026-09-09。验收 agent：`stage_acceptance`。验收职责为只读检查实施结果、给出明确结论和必修项；不承担适配器或实施文档修复。本文件仅记录证据，不将计划中的能力标记为完成。

## 阶段 1：源码、数据锁定与 15 + 15 选题

验收结论：**PASS（源码/数据锁定与候选选题范围）**。这不是清单冻结、镜像就绪、评分校准或可启动实验的通过结论。两清单当前均明确标记为 provisional/candidate，必须通过后续校准后才可冻结。

已独立核对的材料：

- 外部根目录为 `/home/liuyihua/Dev/RA-Agent/benchmark-lab`，源码与数据位于当前仓库之外。
- `sources/FeatureBench` 的实际 Git HEAD 为 `8d4e347ec57546685c5a87e8676bf575db022ea6`。
- `sources/CooperBench` 的实际 Git HEAD 为 `b0262a7b64df945944b5063745369bb2d78d4b57`。
- `datasets/FeatureBench/76b4a4566e04f4bcc13c35125d4f301791efa736`
  含 full、lite、fast 的 Parquet 文件及数据说明。
- FeatureBench 数据字段含
  `instance_id`、`patch`、`test_patch`、`FAIL_TO_PASS`、`PASS_TO_PASS`、`image_name`、`repo`、`base_commit`、`problem_statement`、`repo_settings`。阶段验收需将锁定 manifest 与实际字段及原 prompt 字节核对。
- CooperBench 当前源码的 `dataset/README.md`
  明确：各 feature 的参考补丁分别在 base 上测试；不能要求任意两个参考补丁可合并。任意 pair 的组合 oracle 为
  `combined.patch`。正式 coop 分数评价 agent 补丁的合并行为，parent 修复后的评分须分开标记。

交付后的检查点：

1. 版本与完整性：源 Git
   SHA、数据 revision/来源、实际文件哈希、可重复的数据读取入口一致；没有将完整数据或参考解下载进仓库。
2. 清单规模与身份：FeatureBench 15 个独立任务、CooperBench 15 个明确 feature
   pair；无同一底层功能的 Level 1/2 重复计数；尽量避免重复 feature。
3. 分工真实性：每题记录两个可分别推进并集成的实质工作，理由源于公开需求，不以文件多为唯一依据，不向 agent 泄漏参考实现方案。
4. 初始化与评分定位：每题含起点、镜像标识、资源/初始化要求、参考解定位、评分入口及产物格式。暂未验证的镜像 digest 与校准状态须明确标记，不能伪称冻结或就绪。
5. 原 prompt：可恢复并核对原始字节；附录与 prompt 保持分离，后续统一版本化。

阶段 2 后续验收将要求逐题 baseline/reference 实际日志、依赖/镜像锁、评分器返回结构与全部 30 题分母；脚本存在或 mock 通过不能替代无模型校准。

### 阶段 1 交付验收证据

审查文件为 `experiments/featurebench-{tasks,lock}.json`、
`experiments/cooperbench-{tasks,lock}.json`
和两份 benchmark 专属进度文件。验收通过只读 Python/Git 检查完成，未修改实施文件，未调用被测模型。

| 检查项                    | 实际证据                                                                                                                                                     | 结论                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 源版本                    | 两 checkout HEAD 与锁文件一致，tracked modifications 均为空                                                                                                  | PASS                 |
| FeatureBench 数据完整性   | 锁定的 7 个文件 SHA-256 与字节数均正确；fast/full/lite Parquet 全部行与派生 JSON 完全一致，分别为 100/200/30 行                                              | PASS                 |
| FeatureBench 选题身份     | 15 个不同实例来自 fast，全部 lv1、15 个不同仓库；selectionSha256 与清单原始文件字节一致                                                                      | PASS                 |
| FeatureBench 原需求与起点 | 15/15 prompt SHA-256 与原始 problem_statement UTF-8 完全一致；repo、base commit、数据 revision 和官方 image_name 一致；每题均有非空 Level 1 参考 patch       | PASS                 |
| FeatureBench 实质分工     | 逐题核对原 prompt 的接口和功能描述；每题两条工作流对应不同需求面并有集成边界，例如 Iceberg 读/写、Cargo cfg/version 与 manifest/lockfile、VOTable 导航与转换 | PASS                 |
| CooperBench 数据完整性    | 771 个 inventory 条目的 SHA-256、总字节数与外部数据一致，全部文件也与源 checkout 的 dataset 对应文件一致；Git tree SHA 为锁定值                              | PASS                 |
| CooperBench 选题身份      | 15 个不同 pair，8 个仓库，Python/Go/TypeScript；每 pair 两个不同 feature，全清单 30 个 feature 身份均无重复                                                  | PASS                 |
| CooperBench 原需求与起点  | 30/30 原 prompt 的字节数、SHA-256，以及 gold/tests/combined/Dockerfile/runner 哈希一致；每题 base commit 可在官方 Dockerfile 或 setup.sh 中确认              | PASS                 |
| CooperBench 实质分工      | 逐题核对两份 feature.md，选择理由对应两个不同公开需求；共享路由、生命周期、缓存和文件操作位置为实际集成边界                                                  | PASS                 |
| 评分材料定位              | 两清单均记录评分入口/语义和必要 patch 产物；CooperBench child 原始分数与 parent 集成分数明确分离                                                             | PASS（接口计划范围） |
| 未完成事项披露            | digest 为 null/unresolved、资源为待测估算、校准 pending/not_run；未冒充冻结或完成                                                                            | PASS                 |

阶段 1 **must-fix：无**。

后续实施注意项（不阻塞阶段 1）：

- CooperBench `inventory_sha256` 是对 inventory 对象作
  `json.dumps(..., sort_keys=True, separators=(",", ":"))` 后的规范化哈希
  `388778654fad268ef73258e83acadcbc9d144a34bf7cd24459127338fc02ff13`，不是 pretty
  JSON 文件的原始字节哈希。原文件哈希为
  `a1ac8d057d01ee4d4c970c6ab5a4083b3750be2068cb38603c6d6cab09573d3b`；验证器和运行说明应明确算法。
- 两个任务 manifest 分别采用 camelCase 与 snake_case，且任务/仓库标识格式不同。公共 runner 必须显式归一化并拒绝不完整准备产物，不能直接按同一 schema 读取。
- 独立 sandbox 的必要性是选题加分项；本次 PASS 只确认实质分工依据，不能据此声称所有题已证明 sandbox 并行收益。

## 阶段 2a：公共 runtime、API、产物及持久化基础

首轮结论：**FAIL**。下列缺陷来自已交付代码，不以尚未交付的 30 题校准或真实模型试跑作为本轮失败原因。审查范围：`tools/benchmark/{artifacts,api,common,environment,relocate_runtime,runner,reporting,cli}.py`、默认实验配置与附录、provider
Python 路径及 child 深度限制、本地 control-plane state/port 配置。

已确认的正向证据：

- 独立执行
  `cache/adapter-venv/bin/python -m pytest tools/benchmark/tests -q -p no:cacheprovider`：**21
  passed**。首次普通沙箱运行仅 loopback HTTP
  socket 被环境拒绝，经过工具审批后重跑全部通过；这不是实现测试失败。
- API sig1 对照 shared 全部 immutable golden
  vectors；超过 200 条分页、重复 cursor 拒绝、创建/提交响应丢失后的只读对账、flock 排他均有通过测试。
- 产物 HTTP 校验 session token
  hash；写入只能使用自身 session 身份，父只能读取自己及直接 children。哈希命名的原始 patch 保留多个版本，published/checkpoint 元数据分开，真实 Git
  roundtrip 覆盖新增、删除、binary 和权限位，且不修改真实 index。
- 读取外部 `cache/runtime-overlay/core.json` 及 dirty-equals、Alpine Go26 的
  `runtime-overlay/runtime.json`/构建日志：runtime 库被重定位，两个环境均执行了 Python
  import 与 OpenCode 启动检查，并记录起始 commit。当前记录的镜像分别为
  `sha256:c745e3c01ed65928f07831f990831e343010cc41d06acc218e566526b4e4447c`、`sha256:cfda601e8c98e6ac0acc66fc555bc37b82a01f2527c214d1247f9050aaee5793`；测试环境 parity 仍标记 pending，未冒充完成。
- 配置明确单题并发、两个 child、禁止孙辈、wall-clock 预算，公开 token/cost
  cap 尚未强制的限制。CooperBench 原 child 分数与 parent 集成分数分开，不按 best
  attempt 剔除失败尝试。

### 首轮发现及修复状态

1. **A1：忽略文件产物丢失，实施方已修复，源码回归通过；镜像重建待核对。**
   原 snapshot 从 base 构建临时 index，导致 agent 已 `git add -f`
   的 ignored 新文件丢失。独立临时 Git 实验确认真实 index 中存在文件、snapshot 却没有。实施方加入真实 index 的 tracked
   NUL
   pathspec，并扩展现有回归；本次再次运行 21 项全通过。旧 overlay 尚不含修复，必须重建后使用新 image
   ID 校准/运行。
2. **A2：必须修复，最终回复不可用被误判成功获取。** `reporting.protocol_evidence` 只查输出含
   `Final response:`；上游 `get-child-status-format.js` 在没有最终回复时恰好返回
   `Final response: not available yet`。独立内存 fixture 使用两个这样的返回、其余协议证据齐全，函数返回
   `passed` 且 issues 为空。应明确区分最终回复可用、仍在运行/无回复、工具失败，并增加对应反例验证。
3. **A3：必须修复，最后代码采集失败仍删除容器。** `capture`
   把 snapshot 错误仅写到 capture-errors，`cleanup` 随即对这些容器执行 DELETE；`cleanup`
   自己的 errors 没有这些采集错误，因而可能同时报告 complete。需要在可靠保存最终代码前阻止删除并保留 cleanup_pending，允许接续重试；TTL 已丢失等不可恢复情形须独立标明证据缺失，不能伪称完整保存。
4. **A4：必须修复，中断评分可被接续当作完成。** FeatureBench 评分开始即写 `score.json`
   且 status=running；`assess_attempt`
   遇到任何现存 score.json 都返回，然后 batch 将 phase 置 done。评分进程中断会留下 running 文件，接续不能据此跳过评分。仅可复用有明确 terminal/completed 标记的评分；重试应保留旧评分 generation，同时不重复模型执行。
5. **A5：必须修复，提交前没有验证锁定 prompt 字节。** `prepare_prompt`
   直接读取 prepared.promptPaths 并对实际内容计算 hash，未与任务 manifest 的 promptSha256/features[].prompt_sha256 比对；freeze 只锁 prepared.json 中的引用路径。准备后外部 prompt 被误改仍可提交。应在提交前验证数量、feature 顺序与锁定 hash；接续时还需验证已保存原文、附录、prompt-manifest 与完整提交内容一致。

后续验收所需材料：A2–A5 修复及针对性反例、A1 新 overlay 身份，provider 与真实 D1
child 行为测试结果。runtime-overlay 的全题 baseline/reference parity 属阶段 2b；真实正常 API
parent/child 试跑、运行中断/接续/清理整链路仍需后续实测，当前基础测试不替代这些证据。

非阻塞注意项：当前宿主采集器按全局 OpenInspect
label 观察容器，exporter 原样附加文件，因此会含同时运行的其他 OpenInspect
session。最终 run 产物应过滤到本 attempt 的已确认 session/container 身份，或将全局宿主观测明确标记并禁止用于本题专属资源归因。`traceProfile`
配置也需与实际 analyzer 调用/记录的 profile 一致。

### 阶段 2a 第二轮复核

独立重跑公共 primitive tests **25 passed**；另独立运行 `test_bridge_interpreter.py`、
`test_supervisor_lifecycle.py`、`test_supervisor_monitor.py`，**21 passed**，合计 **46
passed**。后者包含真实退避等待，用时 67.74 秒；没有执行模型任务。桥接进程由裸 `python` 改为
`sys.executable`，测试确认与 supervisor 使用同一解释器。

| 项目                  | 复核结论                                   | 证据与范围                                                                                                                               |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1 ignored 产物       | PASS（源码与回归）；镜像部署待复核         | 真实 index 显式 stage 的 ignored 文件被纳入临时 index，原真实 index 保持不变                                                             |
| A2 最终回复不可用误判 | PASS                                       | 新 `has_final_response` 拒绝 not available、旧回复仍有新 prompt、空回复；有正文的成功/失败最终回复可识别；对应反例通过                   |
| A3 采集失败仍删除     | PASS（删除门禁）；停止容器恢复路径 pending | `captureSucceeded=false` 时不 DELETE，并维持 incomplete；有针对性的 cleanup 测试。新停止容器 helper 正在真 API warm 验证，本轮不提前通过 |
| A4 running 评分误复用 | PASS（原缺陷）                             | 必须存在独立 completion.json 且 scoreSha256 匹配才能复用；未完成评分保留旧 generation 并创建新目录；回归通过                             |
| A5 prompt 字节固定    | PASS                                       | 生成时校验数量和有序原文 hash；接续重新校验已保存原文、附录、组合内容及 prompt-manifest；CRLF 保留和篡改反例通过                         |

新增 **A6 must-fix：确定的模型/产物失败不能无限阻塞批次**。当前 `assess_attempt`
只接受评分 status 为 scored/complete；CooperBench
score 对缺少 child/parent 产物返回 missing_artifacts。该情况是确定的失败/不可评分结果，但 batch 会保持 collected，每次 resume 都新建评分 generation 后再次失败，无法推进后续题。空模型 patch 触发上游
`Agent patch is empty`
也需区分于真正基础设施故障。应将可确定的模型/协议/产物失败作为终局观测保留在分母并继续，仅对可恢复的评分中断/基础设施失败保留接续重试。

阶段 2a 整体仍为 **FAIL / 待复验**：A6 尚未解决，停止容器提取、最终 runtime 镜像及真实正常 API
warm/中断/清理整链路尚未全部独立验收。

## 阶段 2b：CooperBench 官方环境无模型校准子项

本子项结论：**PASS（15 / 15 官方 baseline、individual gold、combined
gold 校准）**。这不代表阶段 2b 整体通过；FeatureBench 全题校准、最终 agent
preparation、runtime-overlay parity 及真实模型试跑各自保留独立状态。

| 清单中的任务              | 原始 base 两 feature | individual gold 两 feature | combined gold 两 feature |
| ------------------------- | -------------------- | -------------------------- | ------------------------ |
| dirty-equals 43 [2,3]     | 两者预期失败         | 两者通过                   | 两者通过                 |
| Go chi 26 [1,2]           | 两者预期失败         | 两者通过                   | 两者通过                 |
| Go chi 27 [2,4]           | 两者预期失败         | 两者通过                   | 两者通过                 |
| Go chi 56 [2,4]           | 两者预期失败         | 两者通过                   | 两者通过                 |
| React Hook Form 153 [2,3] | 两者预期失败         | 两者通过                   | 两者通过                 |
| React Hook Form 85 [3,4]  | 两者预期失败         | 两者通过                   | 两者通过                 |
| Click 2068 [2,10]         | 两者预期失败         | 两者通过                   | 两者通过                 |
| Click 2800 [6,7]          | 两者预期失败         | 两者通过                   | 两者通过                 |
| Click 2956 [2,7]          | 两者预期失败         | 两者通过                   | 两者通过                 |
| Jinja 1465 [2,3]          | 两者预期失败         | 两者通过                   | 两者通过                 |
| Jinja 1559 [6,9]          | 两者预期失败         | 两者通过                   | 两者通过                 |
| Jinja 1621 [2,9]          | 两者预期失败         | 两者通过                   | 两者通过                 |
| Pillow 25 [3,4]           | 两者预期失败         | 两者通过                   | 两者通过                 |
| datasets 3997 [2,4]       | 两者预期失败         | 两者通过                   | 两者通过                 |
| DSPy 8394 [3,4]           | 两者预期失败         | 两者通过                   | 两者通过                 |

独立核对的证据链：

- 从当前 manifest 的每个 `calibration_report`
  定位实际 attempt 报告，**15 个报告 SHA-256 全部匹配**，且其 task
  ID、feature 集合、源码 SHA、官方 image
  ID 与锁文件一致。task 级 latest 与其 attempt 报告逐字节一致。
- 15 题共 **90 次实际 runner 测试调用**，从原始 transport
  JSONL 逐条核对：30 次 base 非零退出，60 次参考解测试零退出。每题两个 baseline 均有观察到的失败计数，两个 individual
  gold 均通过，combined 的两份测试均通过。
- 对应
  **75 个评分容器**的 transport 日志均含一次成功 cleanup。没有把仅 setup 成功、空测试输出、缺镜像或依赖安装错误当作通过。
- 抽查失败原因与要求一致：dirty-equals 基线因缺 `IsMac`/`IsEmail` 导入失败；DSPy 基线缺 TTL/stats
  API，参考解的新增测试真实通过。
- 所选 30 份 prompt、gold patch、tests
  patch 哈希全部与固定数据相符；替换后的 30 个 feature 身份仍不重复。15 个官方镜像均有 manifest
  digest、本地 image ID、平台及 base/runner 校验记录。
- 当前离线 wheelhouse
  **102 份 wheel 的 hash 全部匹配锁文件**，没有未锁定的额外 wheel。补充内容为构建及原 runner 要求的依赖；镜像测试使用 network
  none、只读 wheelhouse、PIP_NO_INDEX，原测试和参考解未修改。
- 评分函数从已锁定 SHA 的上游 sandbox.py 加载，AST 仅移除 CooperBench 包内 transport/路径/镜像导入并注入替代项；没有替换 pass/fail 判定或把两个 individual
  gold 强行合并。combined oracle 使用完整 combined.patch。

Go56 候选更换验收：**PASS**。原 `[1,5]` 的失败 attempt 和 `gold-diagnostic.json` 保留在
`runs/calibration/cooperbench/cooperbench-go-chi-56-1-5/`。原 feature 1 gold 的诊断为 6 passed / 2
failed，明确记录 Allow header 收到 `[HEAD GET]` 而测试要求 GET、HEAD 顺序。当前 `[2,4]` manifest 有
`replaces` 和理由，对应独立 core unknown-method handling 与 method-validation
middleware；替代 pair 已完整校准。更换发生在模型调用前，依据参考解/测试兼容性，不属于按模型成功率筛选。

冻结元数据复核：初查发现格式化后 `selection_manifest_sha256`
与原始文件字节不符，实施方已修复。再次独立核对，清单 raw SHA-256 与锁均为
`857adfbebfd3eedcf573587b83400fdb21e1e19a34826e185e4264d107289d7b`，并新增明确 raw-byte 算法说明；此缺陷已关闭。此处 frozen-after-official-calibration 仅表示 CooperBench 选题与官方校准锁定，统一实验启动仍需全套 freeze 门禁。

计数解释限制：上游 `_parse_results` 仅取第一段 pytest summary；例如 DSPy TTL gold 的结构化字段记 10
passed，但原始输出另有新增测试 4
passed。已独立核对两段均通过，不影响本次二值校准；不可把该结构化 count 当作整个 runner 精确总测试数。

本子项当前 **must-fix：无**。最终 clean preparation / runtime-overlay parity 为
**pending**，按最终镜像 ID 重新校准后再验收；不得把本节 PASS 扩展为真实 OpenInspect 实验已通过。

## 增量复验：CooperBench preparation/bootstrap、A6、停止容器产物

本轮只验收下表已完成项；新增 OpenCode uid 10001、no-new-privileges、私有 runtime
Python/node_modules 的最终隔离镜像及 warm 检查仍为 **pending**。

| 交付项                                        | 独立验收结论                                      | 证据                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CooperBench clean preparation                 | **PASS，15/15**                                   | 实际启动 15 个一次性 read-only、network-none 容器；逐题验证 HEAD、原始 tree、单 commit、无 remote、无 grader runner/patches、tracked worktree 干净，均匹配锁及 preparation-verification；30 份 prompt 和 15 份 source archive 哈希也匹配 |
| Pillow gitlink、datasets ignored tracked 修复 | **PASS**                                          | 新索引从原 tree 还原 gitlink 并强制纳入原 tracked 文件；真实镜像的 tree 与官方锁一致，tracked worktree 检查为空，未把原 fixtures 或 gitlink 从基线丢弃                                                                                   |
| 仓库 bootstrap 可重复入口                     | **PASS（新外部目录、同 Docker daemon 缓存条件）** | 独立核对 fresh root 的源码 SHA、771 数据文件、102 wheel 及提供的日志哈希；再将全部 HTTP(S)/ALL proxy 指向不可达 `127.0.0.1:1`，真实重跑仓库 `cooperbench.py bootstrap`，完整 15 镜像验证成功                                             |
| A6 缺产物终局状态                             | **PASS，缺陷关闭**                                | assess 接受 missing_artifacts 作为终局，写 completion marker 后重复 assess 不再评分；新增反例通过，公共测试独立重跑 **26 passed**                                                                                                        |
| 空模型 patch 评分                             | **PASS**                                          | 真实 empty-artifacts-score 返回 status=complete，原 child 与 parent 两类结果均 false、error=null，保持上游 patch 失败输出；没有把空模型结果升级为可重试基础设施异常                                                                      |
| 停止容器实际代码恢复                          | **PASS，A3 完整恢复子项关闭**                     | 对新增 binary、可执行权限、删除、显式 stage 的 ignored 文件，expected/recovered patch 逐字节及哈希匹配；另由验收方用真实容器独立重放，停止前后 patch 完全一致                                                                            |
| 首次失败 warm 的后续清理                      | **PASS（恢复与资源清理）**                        | recovery.json 记录空工作区 patch 及 cleanup complete；独立 Docker inspect 确认旧 cleanup.json 中残留容器已经不存在。原 incomplete cleanup 报告保留，未抹去首次失败                                                                       |

CooperBench preparation 验证依据为外部
`runs/calibration/cooperbench/preparation-verification.json`。早期部分 prepared.json 没有新增 baseTree 字段，本次以实际 Docker 读取结果对照锁文件及验证记录确认；公共 runner 需要的字段完整，未因此误判准备失败。原 Docker
lower layers 仍由 daemon 保存，agent 未获得 Docker
socket；此处无历史结论限定为 agent 容器可见文件系统，而不是声称已擦除宿主 Docker 层。

Bootstrap 证据为 `runs/calibration/cooperbench/bootstrap-verification.json`，fresh root 为
`reproducibility/cooperbench-clean-room`。此次证明在全新外部资料目录重建固定输入，并在已有 daemon 镜像缓存上独立验证 registry 内容/离线接续；**没有声称测试过空 Docker
daemon 下的全量冷下载**。最初 SSL EOF 下载失败及已下载缓存被保留，接续后完整性检查通过。

停止恢复证据为
`runs/stopped-capture-1fa45c8ef5ef4f62b3402396f5655f13/{verification.json,expected.patch,recovered.patch}`。patch 为 1316
bytes，SHA-256 为
`587f7118e83701809156bef711f0afc4437cab7a3c54289717216e21411c76c4`。原验证 runtime 镜像
`8dce2345...` 已不在 daemon；验收方使用相同 dirty-equals clean
prepared 基线和当前 snapshot_container 实现重放，得到完全相同 patch。测试容器及离线 helper 均移除，没有模型调用、宿主执行模型 Git 配置或接触其他实验代码。

本轮已交付项 **must-fix：无**。A1–A6 所述基础缺陷均有关闭证据；阶段 2a 当前整体为
**pending 最终隔离 runtime/warm 验收**，阶段 2b 仍需最终 runtime-overlay
parity 和 FeatureBench 全题校准。真实模型 parent/child 试跑及全批次验收不能从这些 PASS 推断。

## 增量复验：首次无模型 warm、降权采集与运行时重启边界

本轮按实施方后续要求进行**纯只读代码和已落盘证据复核**，未构造或执行 Git
filter、权限绕过测试，未读取凭据或答案。已完成的首次启动子项 **PASS**；最终隔离子项整体仍为 **FAIL
/ 待修复复验**，原因是下列 A8、A9 的重启及辅助进程边界没有被首次 warm 覆盖。

| 已交付项                                    | 验收结论                       | 证据与范围                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 正常 API 无模型 warm                        | **PASS，限定已验证镜像**       | `runs/warm-694462176f5246f1967f4d163d2a4aa3/`：Go26 镜像 `de0f6f627b3e5b88d3e4df1d00a99e1d21da9363372acfb284e4b773a76fe5e8`，root session `137907e704714da8ac636560033b75ea`，真实 ready、1 session、0 messages；ready 中 repositories=[]                                                                                                                                            |
| OpenCode 首次启动降权                       | **PASS，首次启动**             | `agent-boundary.json` 记录实际 OpenCode PID 31 的 real/effective/saved/fs UID 均为 10001、NoNewPrivs=1；该 UID 不可读 runtime site-packages/node_modules，任务 workspace 可写；launcher 在 exec 前清 supplementary groups 并设置 gid/uid                                                                                                                                             |
| 模型连接无生成检查                          | **PASS，仅认证与可用性**       | `model-access.json` 记录 DeepSeek `deepseek-v4-flash` authenticated GET models；检查脚本未发生成请求。不能据此声称模型生成或 parent/children 协作已测试                                                                                                                                                                                                                              |
| trace、analysis、清理                       | **PASS**                       | cleanup complete、remainingContainers=[]；独立重算 trace 14 个文件和 analysis 14 个文件哈希全部匹配；analysis validation.valid=true、llmUsed=false，1 ready/0 messages/0 tools 与此次 warm 范围一致                                                                                                                                                                                  |
| warm 失败状态真实性                         | **PASS，旧误报已更正**         | `warm-7fa2564ace134637aeccc658d9ce1c6f` 和 `warm-3ef139cca87b471b818b0b07f9dcdde8` 原 complete 已更正 failed，`warm.before-status-correction.json` 保留，前后 failure 相同；finally 仅在 ready、cleanup complete 且无 failure 时标 complete                                                                                                                                          |
| A7 周期与停止容器 Git 采集降权              | **PASS，Git 执行用户缺口关闭** | running `docker exec --user 10001:10001`；stopped helper 复制后 workspace 归属 10001，runtime 两依赖目录 0700，再以相同 UID 和 no_new_privs 执行 oi-bench。最新 `stopped-capture-202761ac2a1746c180010d143d735964` expected/recovered 均为 1316 bytes，SHA-256 `587f7118e83701809156bef711f0afc4437cab7a3c54289717216e21411c76c4`；包含新增 binary、删除、可执行权限、forced ignored |
| 最新 launcher 性能修订与最终 overlay parity | **pending**                    | lstat 已为目标 owner 时跳过 chown 的代码可见，但本表 warm 使用更早镜像；全题最终镜像和 parity 队列尚未交付验收，不沿用旧镜像结果宣告完成                                                                                                                                                                                                                                             |

此次发现并已由实施方修复的 A7 是：原 host checkpoint 以默认 root 执行模型可改 Git 仓库中的
`git add`，未维持 OpenCode 新增的 UID 边界。上表仅关闭 Git 子进程的执行用户问题；停止 helper 的 root
Python 准备步骤另受 A8 约束。

公共 root Git 路径的适用条件也已核对：

- `diff_collector._git` 继承 root；各 diff 已有
  `--no-ext-diff --no-textconv`，但并未全面排除仓库配置中的 clean
  filter 或 fsmonitor。`SessionDiffRefreshWorker._settle` 在空 repo
  manifest 时直接返回。当前 runner/warm 创建 payload 只有 title/model，真实 ready 也证明 repositories=[]，所以当前实验不进入 collector；若后续改成非空 manifest，必须重新验收 Git 执行身份。
- `repository_sync`、`git_signing` 遍历已配置的 repositories，当前为空。`bridge._run_git_push`
  需接收 pushSpec；实验流程没有请求 push，仓库工具在 has_repository=false 时不安装。这些条件不应被本次 PASS 扩展成公共 runtime 对所有工作模式均已隔离。
- `opencode_server.start` 在 workdir/.git 存在时，仍可能以 root 调用
  `git_excludes._git_exclude_path` 的 `git rev-parse`
  并读写 info/exclude。该命令本身不运行 diff/textconv；首次启动读取固定基线。重启会再次处理已可被模型修改的工作区，需与 A9 一并处理。

尚需修复并复验：

| 编号 | 代码位置与触发条件                                                                                                                                                                                                                                                                                                                                                           | must-fix                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A8   | `agent_bridge_process.AgentBridgeProcess.start` 以 root `sys.executable -m sandbox_runtime.bridge` 启动、继承 `/workspace`，未禁 cwd 导入；FeatureBench `/workspace` 或其 `/testbed` 目标为模型可写时，bridge 重启的 Python 导入来源可受任务文件影响。`runner.snapshot_container` 停止 helper 在复制任务后以 root `python3.12 -S -c ownership` 导入 pathlib，也未禁 cwd 导入 | 为 root runtime/辅助 Python 固定受信导入来源或 cwd，并验证实际重启/恢复入口；`-S` 只禁 site 初始化，不移除 cwd                                                                          |
| A9   | `launch_opencode.launch` 对模型可改 `/workspace/.opencode` 等 top 使用 `os.walk(..., followlinks=False)`，未拒绝 top 本身是 symlink；`opencode_server._install_tools` 在降权前向同一可改路径 shutil.copy。supervisor 在 OpenCode crash 后会再次调用 start                                                                                                                    | 重启期间不得以 root 跟随模型控制的 staging/ownership 路径；可在 benchmark 范围固定受信路径、调整执行用户，或明确失败回收且不在同一工作区执行 root 重启准备。修复后提供普通启动/恢复证据 |

A8、A9 为只读代码审查结论，并非声称已实际执行提权或读取私有文件。最终阶段 2a、全 30 题校准、冻结及真实模型试跑均不能由本节首次 warm
PASS 推断。

## 阶段 2a 最终复验：A8/A9 关闭，公共接入 PASS

本轮结论：**PASS（公共 runtime 接入、无模型 warm、产物传输与故障回收）**。A1–A9 均已有关闭依据，当前本阶段
**must-fix：无**。本轮仅只读复核代码和已落盘证据，没有执行攻击性测试、读取凭据或答案。全 30 题最终镜像 parity、FeatureBench 全题校准、模型驱动的 parent/children 试跑仍是后续阶段，不能由本节 PASS 代替。

本次验收绑定 core `20a32f60311a04e2e8a4cdba230c293b04db963eef3d4a4872c8e0ab5b334269` 及 Go26 overlay
`0f691a5a14605bedaba9d8901f3dcb9a803e4bb0d1cf8beb4b7632fd0f2bf991`。独立重算 core 记录的
**64 个 runtime 源码文件 hash 全部匹配当前仓库**；overlay
Dockerfile、artifacts.py、launch_opencode.py 哈希匹配 runtime.json，configure_overlay.py 及其他已复制脚本与当前实现逐字节一致。实际 warm 的 connection.python_path 为
`/opt/oi-tools/python-runtime`，containers.json 指向上述固定 overlay。

| 验收项                              | 结论                             | 修复和证据                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A8 root Python 导入来源             | **PASS，关闭**                   | configure_overlay 生成 python-runtime 包装器并以 `python3.12 -I` 启动 supervisor；runner 的 CP 配置和 overlay ENTRYPOINT 均使用该包装器。bridge 使用父解释器并在 isolated 模式下保持 `-I`，其他产品模式使用 `-P`。停止 helper 的所有 root Python 步骤显式 `-I`，复制后的 ownership 步骤为 `-I -S`；模型采集包装器亦隔离导入 |
| A9 模型修改工作区后的 root 重启准备 | **PASS，按实验禁止重启策略关闭** | launcher 拒绝 ownership top 本身为 symlink；更关键的是 protocol 强制 runtimeMaxRestarts=0，overlay 写 SANDBOX_MAX_RESTARTS=0。supervisor 第一次 OpenCode/bridge failure 即退出，不再向已运行模型的工作区执行 start/staging；产品未配置时仍默认最多 5 次重启。此结论不声称通用产品重启 staging 已全部重写                    |
| 实际崩溃策略                        | **PASS**                         | `runs/warm-65a631d10bd14d6db969849dc1dc5c3d/crash-policy.json` passed；独立核对原始 runtime 日志仅一次 opencode.start 和 bridge.start，随后 OpenCode exit=-9、restart_count=1、max_restarts、supervisor.fatal、shutdown_complete，**没有 opencode.restart 或第二次 start**                                                  |
| 实际 UID、NNP、私有依赖及模型连接   | **PASS，无生成**                 | 新 agent-boundary 中实际 OpenCode 四类 UID 均 10001，NNP=1，runtime 私有依赖不可读、workspace 可写；model-access 仅 authenticated GET models，warm 与 trace 均无模型消息                                                                                                                                                    |
| 子 session 工具注册                 | **PASS，注册层**                 | `/app/sandbox_runtime` 链接补齐固定 runtime 工具源；真实 OpenCode tool API 返回 17 个可用工具，包含 spawn-child、get-child-status、send-child-prompt。尚未声称执行了模型驱动的 spawn/协调                                                                                                                                   |
| 容器产物传输                        | **PASS，单 session 实际传输**    | 新 warm 中 UID 10001 通过 oi-bench publish/fetch 访问鉴权宿主 bridge；artifact-transfers.jsonl 的发送方、接收方、hash 与 publication 相同。此次为空 patch，hash 为 e3b0c442…；跨 session 授权沿用此前独立 primitive 验证，非本次单容器 smoke 的结论                                                                         |
| 终止后采集、清理及报告              | **PASS**                         | stopped 容器已有 checkpoint.json，内容与发布空 patch 哈希匹配，无 capture-errors；cleanup complete、remainingContainers=[]。trace 和 analysis **各 14 个文件 hash 独立重算全通过**，1 session / 1 ready / 0 messages，analysis.valid=true、llmUsed=false                                                                    |

实施方报告相关
**52 项测试通过**。本轮只读检查了 bridge 解释器参数和 supervisor 零重启/非法参数测试代码，并结合真实 warm 生命周期和停止采集证据验收；没有把该测试数量写成验收方本轮独立重跑结果。

阶段 2a 的生效前提仍是：空 repo
manifest、无 push、固定协议的两 child/深度 1、无自动 runtime 重启、agent UID
10001 与 no_new_privs、runtime 私有依赖目录保护，以及按实际镜像 ID 保存证据。最新 packaging
warm 当时尚在执行，其他任务最终 overlay/parity 尚在队列；必须分别验收并通过全套 freeze 门禁后，才可宣告实验全量准备完成。

## 公共接入补充验收：packaging warm、产物覆盖与 batch 报告

本轮仅检查新增交付，不重复此前 A1–A9；全量 30 题阶段 2b 仍待另行验收。补充项结论：**packaging
warm、analysis 失败状态、batch fixture PASS；最终产物覆盖标记 FAIL，存在 A10
must-fix**。此前公共 runtime 接入 PASS 保持其原范围，但新增的“最终采集完整”报告能力尚不能作为冻结后真实运行的完成依据。

| 补充项                                              | 结论                     | 独立检查                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packaging 最终无模型 warm                           | **PASS**                 | `runs/warm-3d2e4debb6694882b2b0c5b766664ff2/`，overlay `4c9e54c82d241b3b96acc9afc49712f628a8c8262ebb9e158a39daeb50f45001`、同 core `20a32f60…`；overlay 的 Dockerfile、launcher、artifacts hash 和 core 64 源文件均匹配。真实入口使用 python-runtime，UID 四类均 10001、NNP=1，私有依赖不可读，17 个工具包含三项子 session 工具，publish/fetch 的空 patch 与传输日志一致，GET models 无生成，cleanup 无残留 |
| packaging trace/analysis                            | **PASS**                 | 0 messages，trace 与 analysis 各 14 个文件独立 hash 验证通过；该 warm 早于新增 coverage 字段，未落盘 artifact-coverage.json，因此不拿它证明新增 coverage 实际分支                                                                                                                                                                                                                                           |
| analysis 失败保留已导出 trace                       | **PASS，代码与回归检查** | export_trace 在 export 成功后先写 trace.path/status；分析 RuntimeError/OSError 单独写 analysis.status=incomplete、path、error，调用方仍能保留 trace。新增回归明确断言 trace 不丢失；实施方报告 29 项协议测试通过，本轮按要求没有重跑                                                                                                                                                                        |
| 两 warm trace + 一个未开始 attempt 的 batch fixture | **PASS，分析接入范围**   | `runs/no-model-report-validation-ad003d8f683e4e2a81e06c00cfd9dff3/validation.json` 明确 validationOnly/no model/no scoring。两个 collection 副本各 16 文件与原 trace 逐字节一致，batch 5 个输出 hash 全匹配，successfulRunCount=2、failureCount=0、failures.jsonl 为空                                                                                                                                      |
| 计划分母及未评分状态                                | **PASS**                 | inputs.json 和 report.json 的 plannedAttempts=3；001/002=no_model_validation，003=not_started。FeatureBench planned=1/unscored=1，CooperBench planned=2/unscored=2；未凭分析成功构造基准评分。一次 attempt 只复制 state.trace.path 的最后一次导出，不把续传的多个 trace generation 算作额外试验                                                                                                             |
| 丢失容器仅剩 checkpoint 的覆盖标记                  | **PASS，限定该分支**     | 新回归中 session 无容器但有 checkpoint，cleanup 可 complete，artifactCoverage 必须 partial，finalCapture=false；两种完整性被分开记录                                                                                                                                                                                                                                                                        |
| 正在运行容器的最终采集标记                          | **FAIL，A10**            | cleanup 在 cancel 返回后，对 captureSucceeded 且 session 在 cancelled 集合中的容器直接记录 finalCapture=true，未要求 container.running=false 或其他工作区稳定证据，随后可立即 DELETE 容器                                                                                                                                                                                                                   |

**A10 must-fix**：取消请求成功不等于模型进程已经停止。 `session-lifecycle.handler.cancel`
仅发送异步 shutdown、更新控制面状态后返回；对已经 terminal 的 session 返回 409，Client 将其视为 alreadyTerminal，甚至不会触发 shutdown。因此
`runner.cleanup`
可能把仍在退出或仍有进程运行时的 checkpoint 误标为最终完整，而采集结束到删除之间仍存在工作区变动窗口。应先得到停止或冻结工作区的明确证据，再标 finalCapture；未取得该证据只能保留 partial。新增 lost-container 测试未覆盖这个 running 分支，修复后需要针对该分支的普通回归/恢复证据。本轮仅只读推导了上述路径，未执行构造测试。

Batch fixture 的“2 successful runs”表示
**2 份 trace 分析成功**，不是 2 道题完成或通过。该 fixture 直接调用 analyze_batch，report.traceBatchAnalysis 尚未由完整 execute 收尾写入；它证明 batch 函数接入和三次计划的报告分母，不证明真实模型运行、评分或整套 execute/resume 收尾均已实测。

## A10 复验：最终采集顺序及非空产物 PASS

本轮结论：**PASS，A10 关闭**。公共接入及其新增产物覆盖/报告子项当前
**must-fix：无**；全量阶段 2b 与冻结仍待其自身验收。本轮只读复核修复代码、普通回归和真实无模型 warm 证据，没有运行攻击性测试或修改实现。

- `runner.cleanup` 在 API cancel 后重新通过本 session
  tree 的 containers_for 查询精确容器，对 running 容器执行
  `docker stop --time 10`，命令上限 30 秒；之后再次 inspect/capture。仍 running 或 captureSucceeded=false 的容器均跳过 finalCapture 和 DELETE，停止失败留下错误、容器和 partial 状态。
- stopped 容器沿已验收的离线 helper 路径采集。只有确认 stopped 且采集成功后，才落盘 finalCapture 并调用 native
  DELETE，不再把异步 cancel 响应当作工作区已经停止的证据。
- 新回归 `test_running_workspace_is_not_final_or_deleted_when_stop_fails`
  明确构造 stop 失败、running=true、captureSucceeded=true 的普通状态组合，断言不发 DELETE、cleanup=incomplete、coverage=partial、finalCapture=false。实施方报告 30 项协议测试通过；本轮未重跑该数量的测试。

真实验证为 `runs/warm-5e455f43a67e48f9956e22aea868440b/`，仍使用固定 Go26 overlay
`0f691a5a14605bedaba9d8901f3dcb9a803e4bb0d1cf8beb4b7632fd0f2bf991`。实际 UID
10001 在任务目录写入普通无模型验证文件，经 publish/fetch 传输 **298 bytes**
patch。独立重算 published、checkpoint 文件 SHA-256，均为
`e69a3c52e45a6f9b14d5df583068786d54796b79800e8c3639bc13d1bd731433`；传输日志和 artifact-coverage 内两份元数据完全一致。最终容器记录 running=false，原始日志 supervisor.shutdown_complete 早于 finalCapture，coverage=complete、cleanup=complete、remainingContainers=[]，无 capture-errors。trace/analysis 状态分别为 exported/complete，各
**14 个文件 hash 独立重算全部通过**，1 ready/0 messages，未执行模型生成或评分。

新增 status/freeze 关联检查：**PASS，代码范围**。两处均调用 validate_runtime_provenance，要求 runtime.core 与当前 cache/runtime-overlay/core.json 完全相同，复制的 artifacts/launcher/configure_overlay 与当前仓库脚本 hash 一致，已有 metadata
hash 及 Dockerfile
hash 保持匹配；overlay 校准还必须明确指向该 runtime.imageId。因此旧 core 或旧 image 的历史 parity 不再计为当前任务通过。本结论不代替全题校准、实际 freeze 执行或后续模型试跑验收。

## 运行说明预检：新会话接续路径

预检结论：**FAIL，存在三项运行说明 must-fix；不影响此前公共 runtime 接入结论**。本轮以
`docs/BENCHMARK_RUNBOOK.md`、仓库 CLI
help、配置及落盘状态为入口，仅阅读必要实现核对差异。实际只运行 help 和已授权的
`bench:status`，未启动 worker、准备、校准、模型或 stop 操作。此处不是阶段 2b、两题模型试跑、30 题验收或最终新会话验收。

已确认可用及表述准确的部分：

- 按手册设置仓库内 Node PATH 后，npm bench aliases 与 CLI
  help 一致；status 正常刷新外部 preparation-status.json。检查时 suite=pilot-30、frozen=false、activeBatch=null，30
  selected / 20 officialPassed / 4 overlayPassed / 19 prepared / 13
  runtimeBuilt；这些是动态准备计数，不是阶段验收结果。
- 落盘 freeze-preflight 明确 frozen=false、eligibleCount=4、26 项 pending；没有启动模型批次或绕过门禁。手册把两题模型试跑和 30 题单轮放在全题校准及冻结之后，未将 warm/分析 fixture 冒称为模型试跑完成。
- 默认 pilot-pair / acceptance run、原 run-id
  resume、report 命令参数均可被当前 CLI 接受。resume/report 缺省读取既有批次 config.json；report 仅汇总现有状态，不提交模型或自动重算分析。
- suite_lock_path 已用于 freeze、require_freeze、status，路径为
  `experiments/<config.suite>.lock.json`；默认仍是 pilot-30.lock.json。`--suite`
  可省略，提供时必须匹配 config.suite。保留旧 suite 的实现已具备，手册若举新版本示例应同时更改配置内 suite 并传
  `--config`，不能只改配置文件名。

| 编号 | 手册与实现差异                                                                                                                                                                                                                                                     | must-fix                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | “离线分析失败”段只说使用既有分析 CLI，未给入口、profile、输出或 cache 参数。实际单 trace `cli.mjs` 默认 **block-ab-v0**，默认输出在仓库 analysis/openinspect；batch CLI 默认 cache 也在仓库，和本实验 block-d0-v1、外部输出约定不同                                | 写出单 trace 与已生成 batch collection 的确切恢复命令，显式采用批次配置的 profile、外部新输出目录及外部 cache；说明 bench:report 不等于重算分析，直接分析 CLI 也不会自行更新 attempt.json 的 analysis 状态。只需使用现有 CLI，不要求新增功能                                                               |
| B2   | worker 段把 FeatureBench index.json 和 CooperBench `<taskId>/calibration.json` 用作“worker 是否仍工作”的入口。前者为官方 generation，最终 overlay 另有 overlays-index.json；后者实际是官方已完成评分报告，没有 worker PID，不能判断当前 runtime parity worker 状态 | 补充当前 overlay 状态入口及确认进程/当前任务的方法：FeatureBench overlays-index.json；CooperBench overlay-build-summary.json / overlay-parity-summary.json。明确旧报告和 stale PID 不证明 worker 存活，并给停止后按 task-id 接续官方/prepare/overlay 的具体命令，避免根据官方已完成报告重复启动最终 parity |
| B3   | 新机器 bootstrap 段直接给 `python3 featurebench.py bootstrap`，没有注明硬性 Python 前置版本；featurebench.bootstrap 对 platform.python_version 与锁中的 **3.13.5** 作精确比较，不符立即拒绝                                                                        | 在该段明确 bootstrap 必须使用锁定 Python 3.13.5，并给版本检查/选择已安装解释器的可执行方式。本机 python3 恰为该版本，因此当前机器命令可用，但不能把它默认为任意新机器成立                                                                                                                                  |

已读取实际 help：单 trace 入口为
`node tools/openinspect-trace-analysis/cli.mjs analyze <trace-bundle> --profile <id> --out <directory>`；batch 入口为
`node tools/openinspect-trace-analysis/batch-cli.mjs <trace-collection> --profile <id> --out <directory> --cache <directory>`。CooperBench 当前两个 overlay
summary 确实关联最终 core `20a32f60…` 且 status=running；官方 Go26
task 顶层 calibration.json 则仍是另一官方镜像的 passed 报告，二者不能互代。

## 运行说明预检复验：B1–B3 关闭，trace 导出接续 PASS

本轮结论：**PASS（运行说明预检与新增 trace 失败接续分支）**，B1–B3 关闭，当前预检
**must-fix：无**。仅只读复核文档/实现/回归代码和现有状态，执行 help 与手册中的只读进程查询；未启动 worker、准备、模型、stop 或修改实现。完整阶段 2b、两题模型试跑、30 题批次及最终新会话验收仍 pending，本节不代表它们通过。

| 复验项                   | 结论与证据                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 离线分析恢复          | **PASS**。新增 `npm run trace:analyze` / `trace:batch` 命令与 package.json 别名及实际 CLI 参数匹配；明确 block-d0-v1、外部新 output、batch 外部 cache，说明 TRACE_PATH 来自 attempt.trace.path、batch 使用既有 collection。手动 CLI 不回写 attempt/run 状态、bench:report 仅汇总的边界准确                                                                                                                                                   |
| B2 worker 与逐题接续     | **PASS**。官方/overlay 索引已区分；CooperBench 最终代际目录的 build.json、verification.json、active.json 实际存在，检查时 build=complete、verification=running。按手册在主机进程命名空间执行 comm 过滤查询得到 3 个实际 worker：FeatureBench 官方、FeatureBench overlay、CooperBench verify，无父 shell；进程数随构建完成变化，不固定声称始终 4 个。单题官方/prepare/overlay 命令参数与 CLI 相符，并要求核对命令路径和开始时间，不能只看 PID |
| B3 Python bootstrap 前提 | **PASS**。新机器段明确 Python 3.13.5、先执行 python3 --version，再运行 bootstrap，符合 FeatureBench 精确版本门禁                                                                                                                                                                                                                                                                                                                             |
| 新 suite 保留旧版本      | **PASS，说明与现有实现一致**。明确配置内使用新 suite 名，--config 选择配置、--suite 仅可选一致性断言，锁为 experiments/<suite>.lock.json，默认 pilot-30 路径不变                                                                                                                                                                                                                                                                             |
| trace 导出失败后的接续   | **PASS，代码与状态回归范围**。execute_batch 对 collected 且 trace 非 exported/complete 的 attempt，先挂接私有 CP 并重新 export_trace；export 失败时 finally 持久化原 collected 状态，异常阻止评分/done。resume 仍从 collected 进入该分支，不调用 run_attempt；导出成功才 assess/done，已 done 的再次 resume 跳过单 attempt 导出与评分                                                                                                        |

新增 `test_resume_retries_failed_trace_export_without_resubmitting_model`
调用实际 execute_batch 状态机，第一次导出失败、第二次成功、第三次再次 resume；断言导出总共 2 次、评分 1 次、失败阶段 collected、最终 done，run_attempt 一旦调用就使测试失败。CP、export、score、batch
analysis 等外部操作由 mock 替代，故它是状态机回归，**不是真实网络 CP/导出/评分整链路重跑**。实施方报告 31 项协议测试通过；本轮未重复执行。

运行手册仍明确区分“命令已实现”“无模型 warm”“全题环境校准”和“真实模型试跑”，没有新增提前完成的表述。离线分析恢复和 trace 导出恢复均使用已存在证据，不重新提交已执行的模型 prompt；批次分析失败后 resume 会重新生成批量分析 generation，旧结果保留。

## 阶段 2b：CooperBench 全量最终环境子项

本子项结论：**PASS（15/15 最终镜像、实际 agent 用户环境、官方评分重放及等价性）**。当前
**must-fix：无**。此前 CooperBench 官方校准、bootstrap、clean
preparation 已获独立 PASS，本轮仅复核必要关联，没有重跑其校准。FeatureBench、全部 30 题套件冻结、两题真实 parent/children 试跑及 30 题模型验收仍
**pending**，不得由本节推断完成。

主证据为外部
`runs/calibration/cooperbench/final-20a32f60-20260909T065404Z/{build.json,verification.json}`；两者均 status=complete、passed=true、恰好覆盖清单中的 15 个不同 task。verification.json 独立 SHA-256 为
`2cc87de829b327ef222258e9e1a282c4eb7db4a6b2bfa0bd39594e0bf1c4ca38`，与 cooperbench-lock.json 的 final_runtime_validation 指针相同。对应 final-evidence-verification.json 是实施方自检记录，本节结论由验收方另行核对得到。

| 任务                      | 最终 image ID 前 12 位 | 两项 individual / combined gold 的上游观察通过数 | agent 可读原测试路径数 |
| ------------------------- | ---------------------- | ------------------------------------------------ | ---------------------- |
| dirty-equals 43 [2,3]     | ed90a62ad0c1           | 78 / 60                                          | 14                     |
| Go chi 26 [1,2]           | 0f691a5a1460           | 3 / 1                                            | 18                     |
| Go chi 27 [2,4]           | 2ffacb3e36ca           | 2 / 4                                            | 18                     |
| Go chi 56 [2,4]           | 1d5e691e1590           | 7 / 5                                            | 17                     |
| React Hook Form 153 [2,3] | 5c38bf2e2cf8           | 20 / 20                                          | 96                     |
| React Hook Form 85 [3,4]  | 456b5246c6cd           | 65 / 63                                          | 96                     |
| Click 2068 [2,10]         | 373dc77974f9           | 66 / 65                                          | 29                     |
| Click 2800 [6,7]          | 3a59f0296ef1           | 79 / 72                                          | 29                     |
| Click 2956 [2,7]          | 5847f6cbb8ac           | 220 / 221                                        | 30                     |
| Jinja 1465 [2,3]          | 11f8d0af3930           | 171 / 168                                        | 31                     |
| Jinja 1559 [6,9]          | ef7bee572db7           | 54 / 61                                          | 30                     |
| Jinja 1621 [2,9]          | 5e83fc93d0af           | 44 / 50                                          | 31                     |
| Pillow 25 [3,4]           | 7ff5ae02553b           | 194 / 195                                        | 1292                   |
| datasets 3997 [2,4]       | e37d356d4162           | 26 / 26                                          | 64                     |
| DSPy 8394 [3,4]           | 815ca12f5bc0           | 10 / 14，TTL 另见下述限制                        | 95                     |

本轮独立检查的证据链：

- **镜像和准备关联 PASS**：15 个 build
  image、runtime.imageId、calibration.grading_image_id、agent.image_id 全部相同；runtime.preparedSha256 匹配当前 prepared.json，taskBaseCommit 匹配 prepared.baseCommit。15 个 prepared 的 baseImage/baseCommit 与此前独立验收的 preparation-verification.json 一致，未暗中换成另一基线。
- **构建来源 PASS**：15 个 runtime.core 完全匹配当前 core
  `20a32f60311a04e2e8a4cdba230c293b04db963eef3d4a4872c8e0ab5b334269`；core 的 64 个源码 hash、environment/launcher/configure_overlay/artifacts 四个冻结脚本 hash、逐题已复制脚本和 Dockerfile
  metadata 均匹配。15 份 calibration 及 15 份 agentEnvironment 原始报告 hash 全部匹配主证据；manifest
  raw hash 仍为 `857adfbebfd3eedcf573587b83400fdb21e1e19a34826e185e4264d107289d7b`。
- **评分重放 PASS**：逐题恰好两个 feature baseline、两个 individual gold、两个 combined
  gold 测试。原始 transport 共
  **90 次 runner 调用**，30 次 baseline 非零、60 次 gold 零退出；各 baseline 有观察到的失败，全部 gold 有正数通过、无失败。15 题 baseline/individual 观察计数与原官方报告一致；combined 两项的原始输出也由验收方独立按锁定上游 parser 重算并逐题对照，全部一致。
- **固定评分脚本与输入 PASS**：75 个评分容器中的 runner 注入内容逐一解码计算 hash，全部匹配任务锁定 runner_sha256；官方参考报告 hash 与原已验收清单指针一致。固定上游 checkout 仍为
  `b0262a7b64df945944b5063745369bb2d78d4b57`，tracked 工作树干净。执行的是官方测试/参考解评分，不是模型生成或自定义替代判据。
- **实际 agent 环境 PASS**：15 份报告共
  **119 个检查**全部 returncode=0；除启动真实 launcher 的 root 检查外，其余均 UID
  10001。每题实际 uid/no_new_privs 输出为 10001/1，原可见测试可读、workspace 可写、runtime 私有依赖不可读、tracked
  worktree 未变；Python 任务的 target import 路径均在
  `/workspace/repo`，Go/Node/npm/pytest/pip/TypeScript/Jest 等任务所需工具检查通过。共读取 1890 个逐任务测试路径，此数包含不同任务间重复文件，不能当作唯一测试用例总数。
- **清理及本地可用性 PASS**：75 份评分容器 transport 均有一次 cleanup
  returncode=0，15 份 agent 检查也都 cleanup_returncode=0。独立只读 Docker 检查确认 15 个精确 image 均存在，linux/amd64、isolated
  Python 入口、SANDBOX_MAX_RESTARTS=0；cooperbench
  grading 和 agent-check 两类标签均无残留容器。没有重新启动容器或重跑 90 次测试。
- **无模型调用边界 PASS**：worker 仅构建、verify-agent 和 calibrate；agent 检查在 network
  none 容器执行 launcher
  --version 和任务工具探测，评分容器同样 offline，仅注入评分材料。子 session 工具注册及正常 API 接入沿用阶段 2a 代表 warm 证据，本节不声称 15 题均运行过模型或 child 协作。

计数解释保持上游限制：自动 calibration_equivalence 对 baseline/individual 比较观察计数，对 combined 本身只比较 passed；本轮补充逐题原始 combined 输出的独立计数对照，确认当前 15 题等价。上游 parser 只读第一段 pytest
summary，例如 DSPy TTL 记 10 passed，原日志另有新增测试 4
passed；已独立检查 individual 和 combined 的两段均通过。表中数字是上游观察计数，不宣称等于整个 runner 的精确用例总量。

新增实际用户环境冻结门禁：**PASS，CooperBench 关联范围**。只读调用当前公共 agent_environment_file/validate_agent_environment，15/15 均选中当前精确镜像且 task 相符、passed=true、cleanup_returncode=0 的报告。freeze 记录该文件及 hash，require_freeze 验证其未变；status 仅在当前 runtime
provenance 有效时计入 agentEnvironmentPassed。bench:verify-agent alias/help 与原 CooperBench
verify-agent 路由一致，支持 --task-id，本轮没有重跑。FeatureBench 分支的 preparedSha/cleanup 条件仅作代码核对，其实际全量报告仍待 FeatureBench 子项交付后独立验收。

## FeatureBench v3 代码与代表题预验收

本轮结论：**FAIL：存在 F1 源码隔离 must-fix**。范围为 v3 包副本处理、prepare/bootstrap 接续、实际 agent 用户检查、2
GiB/8
GiB 资源槽，以及已完成 packaging/Pandas 两题。全部 15 题官方/准备/最终 overlay/UID、全部 30 题冻结和模型阶段仍
**pending**。本轮只读实现、原始报告、归档和 Docker 元数据；没有运行模型、容器内探测、重复校准、变更 worker/镜像或修复实施文件。唯一写入为本验收记录。

### F1：Pandas 的 masked generic 文件被副本身份规则跳过

**必须修复**：`tools/benchmark/featurebench.py:isolate_target_package`
在判断包身份时，从 canonical/private 文件交集中排除了所有 generic 文件，其中包括
`__init__.py`。当前 Pandas v3 准备将 `/testbed/build/cp311/pandas`
写入 skippedSameNameDirectories；该目录确有 44 个必要编译扩展，但其唯一 Python 文件 `__init__.py`
同时也是本题固定 mask patch 要修改的文件。它因此未进入后续 Python 链接/删除处理。

独立读取当前 `workspace.tar`，只计算 hash、长度和机械块匹配，没有输出源码/答案文本：

- canonical `pandas/__init__.py`：8002 bytes，SHA-256
  `39baa7954721021445132b4c2c5f0cd40a98f8d71645a6d57658e7b89622f263`。
- build `build/cp311/pandas/__init__.py`：8161 bytes，普通文件，SHA-256
  `bbf8e494644d36e9e71508d876d7d29ddccc6af140ea23ce64fca3ec62f21d23`。
- 固定数据 mask patch 中该文件的一段完整被删除块长 487 bytes，SHA-256
  `a17eddb55b4625590d358c3e209e14e2756ecd1cd96c5ea0f3ed0f2b1cc81ef9`；该块在 masked
  canonical 中不存在，在 build 副本中完整存在。这证明差异包含未 mask 的原始源码，并非只有构建包装差异。

受影响的当前 prepared image 是
`7fe37ddf95ef0394ce9de1339e3013d5617a59404fd5f041881da457b8dd56ec`，关联最终 overlay 为
`14337c345616747560b42a87752f1f088c1fa2b208ddd5b27fa529d01931cd43`。
`featurebench-pandas-v3-imports.json`
的导入/扩展检查全部成功，但没有核对这个被跳过文件的 mask 等价性，不能单独证明源码隔离完成。

修复应保留已确认构建包的编译扩展，将该 masked Python 文件同步/链接到 canonical，同时继续保留
`hypothesis/extra/pandas` 集成；增加覆盖“只有 generic
Python 文件、有编译扩展且 generic 文件正是 mask 目标”的必要回归。随后生成新的准备/runtime，重做该精确镜像的 parity 和 UID 检查，旧报告保留为历史。验收方不负责修复。

### 其余已完成检查及限制

| 子项                   | 本轮结论与证据                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同名集成与普通副本代码 | **部分 PASS，F1 除外**。3 个现有回归执行准备时实际送入容器的函数源码，覆盖 hypothesis 风格同名集成不变、纯 Python/仅 mask 文件副本重定向，以及二进制 hash 保持、Python 链接、隐藏文件和 bytecode 清除。它们没有覆盖 F1 的 generic-only 构建包分支。实施方报告统一 35 项测试通过，本轮未重跑测试                                                                                                                                    |
| Pandas 可用性          | **PASS，不能代替隔离**。现有 imports audit 显示 canonical 导入、hypothesis 集成正常、44 扩展可用；实际 editable Meson/Ninja 重建输出保留。其 prepared.preservedCompiledPackages 为空，build 目录实际上走 skipped 分支，不能把此证据描述成保留二进制分支已获该真题验证                                                                                                                                                              |
| prepare 恢复           | **PASS，当前单 preparation 锁范围**。ready 默认幂等，失败/中断或显式 --new-generation 归档自有 6 类文件，再写新 generation；其他调用方文件不动。实际 recovery audit 对应外部归档存在，原输出仅保留 unrelated.txt，旧 prepared/log 保留；两道代表题的旧 v2 prepared 也在各自 history 中。不得在旧 adapter 仍持另一锁运行同题时调用清理，见下述过渡限制                                                                              |
| bootstrap 接续         | **PASS**。仅无 HEAD、origin 与锁定 URL 精确相同、工作目录只有 .git 时允许重新 fetch 固定 commit；已有 HEAD 不匹配或 tracked 修改拒绝 reset。只读检查 fresh recovery 目录确认 commit `8d4e347ec57546685c5a87e8676bf575db022ea6`、正确 origin、tracked 干净，7 个数据文件 hash 均符合锁；audit 明确复用了固定 scorer venv/数据，不冒称全量依赖重新下载                                                                               |
| 实际 agent 检查代码    | **PASS，当前代码/两题工具可用性范围**。要求当前 v3 prepared、精确 prepared SHA/runtime image 关联；真实 launcher --version 后，以 UID 10001 执行可见 P2P 读取、workspace 写入、私有 runtime 依赖不可读、任务 Python 导入、pytest 和 tracked worktree 检查。容器 network none、NNP=true；当前 target import 另断言 canonical 目录。两份旧探测命令只输出路径，验收独立核对其输出确在 canonical                                       |
| 2 GiB/8 GiB 资源槽     | **PASS，声明的准备/评分容器资源范围**。score 包含官方和 overlay，统一持原 container.lock，清单 15 题均为 8 GiB；prepare 与 verify-agent 统一持 preparation.lock，明确创建 2 GiB 容器。两槽不嵌套。Metaflow 新 prepared 已记录 2 GiB 限额、172957696 bytes 峰值和全部 OOM 事件为 0；resource-sample-1788939770799716586.json 实测该容器 memory limit 为 2147483648。10 GiB 是这两类容器声明之和，不是整机或 Docker 构建内存实测上界 |

资源迁移限制：archive_preparation 的注释仍以旧全局 container
lock 为互斥前提，而新 prepare 已改持 preparation.lock。过渡期若对尚活跃的旧 prepare 同题重做，可按标签误删活跃容器；本轮没有触发该操作。只读主机
`/proc` 检查资源计划中的旧 PID
423665、453455 均已退出，当前队列只使用新 preparation 锁，因此此迁移条件不构成当前活跃队列 must-fix。历史 PID 记录不能重新被用作当前进程存活证据。

两道代表题的 **评分 parity / 工具环境链 PASS，但 Pandas 隔离 FAIL**：

| 任务 / 最终 image 前缀   | 官方与 overlay baseline F2P | 官方与 overlay gold F2P | 每次 P2P    |
| ------------------------ | --------------------------- | ----------------------- | ----------- |
| packaging / b8d0884a25d1 | 10 passed、284 failed       | 294 passed              | 3508 passed |
| Pandas / 14337c345616    | 1 ERROR                     | 11 passed               | 1887 passed |

上表由固定上游 parser 重新读取 8 组原始测试输出得到，官方/overlay 逐项一致；Pandas
baseline 的单个 collection
ERROR 与 gold 的 11 用例差别沿用官方行为，未将 ERROR 当作成功。两题 prepared/runtime/core
`20a32f60…`、冻结脚本和 Dockerfile hash、base commit、原 prompt hash、workspace.tar
hash 全部关联一致；可见归档中 F2P 测试路径不存在。packaging 归档含 3 个非 mask 目标模块的 bytecode，不能笼统称归档完全无 bytecode；未发现这 3 个文件包含本题的 mask 目标模块。

当前两份 calibration SHA 分别为 `67f29830a2a35f36184fbd8a16f317332caefb1f2d74e249d18f4cfd788f722d`、
`3ab927f19729cfeb9ec01411f513715edb8b5b7393baf822b76a90f896c86f1b`；两份 agent 报告 SHA 分别为
`9579fc48b10ca4f2283751a2df6b5aaafc4f77b1203c4d350dac103dd93581b8`、
`6a20d845c89fa3ad79b771d0eb4e3dbf21d0302b6a0329fa784b984c6644133a`。各 6 个 agent 检查全部成功、每题 5 个原 P2P 文件可读，清理均 removed；只读 Docker 检查确认两个精确 image 存在且两题标签下没有残留容器。以上报告不包含模型生成。

## F1 v4 修复预审与统一 verify-agent 入口补充

本轮
**F1 代码/回归预审 PASS，Pandas 新准备和镜像证据 pending**；F1 仍未整体关闭。只读检查当前源码与测试，不重跑准备、校准、模型或测试。代码 SHA-256 为
`7825858b006d2c4e9dbc31d0e62cfd8bcb3b5f747b97232fc786c4a5f8fde75c`， `test_featurebench.py`
SHA-256 为 `c07b2b7d2395ca03ce2ed6c343b2d8ba34d012cc148475c6498776759e6d80a2`。

- **v4 generic 副本识别 PASS（代码范围）**：prepare 在官方 mask 前，从固定 base
  commit 的 /root/my_repo 采集受 mask 影响的 generic 文件 hash，仅保存 hash。isolate_target_package 对 generic 文件同时要求属于 private_files 且内容 hash 与该原文件相等，才能补充判定为真实包副本；随后沿用编译扩展保留、Python 链接/删除逻辑。无此内容匹配的 hypothesis 风格集成仍跳过；auditVersion 升为 4，识别命中的路径与原 hash 落盘。
- **必要回归 PASS（只读审查测试覆盖）**：新增 test_masked_generic_init_copy_is_distinct_from_same_named_integration 同时建立只有
  **init**.py 的真实编译包副本及同名集成；断言前者链接到 masked
  canonical、原标记不可见、二进制字节不变，后者内容和目录类型不变，并核对识别结果。它覆盖了此前漏掉的 F1 分支；此结论不是新 Pandas 镜像已通过。
- **跨旧锁恢复保护 PASS（代码和回归范围）**：archive_preparation 在 Docker
  client、删除容器或移动文件之前，调用 active_legacy_preparation。该检查要求资源计划中的 task、lab
  root 和 /proc/PID/cmdline 全部精确匹配；匹配的旧同题进程仍活跃则直接拒绝恢复，不阻塞其他任务。新回归启动普通等待进程，验证同题拒绝且原 prepared 未动、不同题放行、PID 对应命令不符不误判，以及进程退出后放行；finally 终止并等待测试进程。此前迁移期误删边界已在已记录旧进程的适用范围内关闭。

Pandas 旧 v3 overlay `14337c345616…`
的评分和 UID 只保留历史，不能作为新准备的现行通过记录。F1 完整关闭仍需要新 prepared 包副本等价证据、最终 runtime 与 prepared
hash 关联、该精确 image 的官方 parity 和 UID 报告；全 15 题保持 pending。

### C1：CooperBench 统一入口覆盖已被引用的 agent 报告

公共 `bench:verify-agent -- --task-id cooperbench-go-chi-26-1-2` 的实际任务工具检查
**PASS**，但证据持久化子项 **FAIL / must-fix C1**。 `runs/agent-verification-report.json`
记录该任务 passed；新原始报告
`runs/calibration/cooperbench/cooperbench-go-chi-26-1-2/overlays/0f691a5a14605bedaba9d8901f3dcb9a803e4bb0d1cf8beb4b7632fd0f2bf991/agent-environment-c7b1082e.json`
的 7 项检查全部通过：实际 UID 10001/NNP
1、18 个原测试文件可读、任务工具正常、workspace 可写、私有 runtime 依赖不可读、tracked 工作树未变，cleanup_returncode=0。这是无模型工具检查，不包含评分或模型生成。

问题在于公共 cli.verify_agent_tasks 传了新
`--output .../overlays/agent-<uuid>`，但 cooperbench.main 的 verify-agent 分支未将 args.output 传入 verify_agent_environment。后者写入固定 image 目录，生成随机名报告的同时覆盖
`agent-environment.json`，因此本次没有生成所传入的 agent-<uuid> 目录。

独立逐项重算原 15 题 final verification 的 agent 报告，当前恰有 Go26 一项失配：

- `final-20a32f60-20260909T065404Z/verification.json`
  仍引用固定路径 agent-environment.json，预期 SHA 为
  `a6e4d8f8bc961a096f51d42180cfb719c07708ebf95cf98d2cbfbef40721561c`。
- 固定路径已被本次运行覆盖，当前 SHA 为
  `d87f7d21de56b387fa43472abc832743bebc60fe6c8b4458a2295cae637017e8`，与新的 agent-environment-c7b1082e.json 相同。
- 原已验收报告仍完整存在于同目录
  `agent-environment-5aac5f75.json`，SHA 与原预期完全相同，未丢失原始证据。

must-fix：统一入口应使用独立输出位置，且冻结/验收汇总引用不可变原始报告；恢复或重新关联原 final 证据链时保留既有历史，不能把一次新的成功检查默认为原 hash 仍匹配。本问题不否认此前 15 题的实际测试结果，但现有 final 汇总的文件关联已不满足原验收条件，修复前不能据其宣称当前 15/15 原始报告 hash 全部有效。验收方没有修复文件。

## C1 复验：报告不覆盖与原证据链恢复

结论：**PASS，C1 关闭；本子项当前 must-fix 无**。本轮只读检查修复代码、回归、恢复 audit、新公共入口报告及既有 final 汇总，不重跑容器、测试或模型。Pandas
F1 新镜像、FeatureBench 全量环境与模型阶段仍 pending。

- **独立输出 PASS**：cooperbench.main 将 args.output 传入 verify_agent_environment；指定输出目录被采用，缺省时创建 image 目录下新的 agent-UUID 子目录。reserve_report 以临时文件加原子硬链接独占保留初始报告，已有报告即拒绝，且此动作早于 docker
  run。过程和最终结果只写本次专有 agent-environment.json，不再覆盖 image 根下旧报告。
- **回归覆盖 PASS（代码审查）**：新增公共回归检查指定路径内容、旧指针字节保持、复用路径拒绝且 docker
  run 次数不增加、已完成报告不变，以及默认生成另一报告路径。Docker 命令由 mock 替代，属于持久化回归，不是容器实测；实施方报告 33 项公共测试完整通过，本轮未重复执行。
- **原证据恢复 PASS**：独立字节比较确认 restoration
  audit 指定的 Go26 根报告与 agent-environment-5aac5f75.json 完全相同，SHA 为
  `a6e4d8f8bc961a096f51d42180cfb719c07708ebf95cf98d2cbfbef40721561c`。导致覆盖的新运行仍保留在 agent-environment-c7b1082e.json，SHA 仍为
  `d87f7d21de56b387fa43472abc832743bebc60fe6c8b4458a2295cae637017e8`；没有丢弃那次执行证据。
- **再次真实公共入口 PASS**：新报告位于
  `cooperbench-go-chi-26-1-2/overlays/agent-278dacebe87b493897e71ceabbba95bc/agent-environment.json`，独立 SHA 为
  `85657295b2c66dc73c1c055c2a2f098d92620b92c2b9485f842e91f44e588950`。7 项检查全部成功，实际 UID
  10001/NNP
  1，cleanup_returncode=0。公共汇总记录 passed；当前 agent_environment_file/validate_agent_environment 确实选中该新目录的精确 runtime
  image 报告并通过，runtime provenance 仍有效。
- **15 题引用完整性 PASS**：在上述新执行完成后，独立重算原 final
  verification 引用的 15 份 agent 报告和 15 份 calibration 报告，30 份 hash 全部匹配，失配为 0。final
  verification 自身 SHA 仍为
  `2cc87de829b327ef222258e9e1a282c4eb7db4a6b2bfa0bd39594e0bf1c4ca38`。此前 CooperBench 全量环境 PASS 的原始证据链已恢复，本次后续检查未再次覆盖它。

## 容量处置复核：六个过期 prepared 镜像与第三次 OCI 展开缓存清理

结论：**PASS（本轮明确列出的处置范围），must-fix 无**。只读检查既有 audit、历史证据、清理实现和 Docker 当前元数据；验收方没有再次删除资源、运行校准或改变 worker。CooperBench
calibration 别名/不可变报告修复尚未作为本节验收范围；FeatureBench
F1 镜像和全量环境、模型阶段仍 pending。

主证据 `runs/audits/retired-featurebench-image-eviction-01.json` 的独立 SHA 为
`347cb5f8886e35f78356f39c41cd8f3b91b45f2dff0e9622aea1fafa4b0ec6c7`。其 candidatesSha256 与
`disk-capacity-20260909T0800-image-candidates.json`
完全匹配。删除记录恰好六项、均 returncode=0；策略限定无 force、无 parent
prune 的定向删除，没有全局 prune。六个 ID 的历史归属如下：

| 旧 image 前 12 位 | 历史 FeatureBench 任务 |
| ----------------- | ---------------------- |
| 22e43de878a8      | MLflow                 |
| 823e93f5b04e      | Pandas v2              |
| dba6939efa2f      | Metaflow v2            |
| b1cd433a065d      | Meson 初次准备         |
| 9aa2d03a6f40      | Meson v2               |
| d648cec3d91f      | packaging 初次准备     |

**归属与保留证据 PASS**：六份 ownershipEvidence 指定的历史 prepared.json 仍存在，逐一重算 hash 全部匹配；benchmark 均为 featurebench、baseImage 均等于对应删除 ID。六项都在固定候选清单中且不在其 79 个 protected
image 集合中；删除前镜像 ID、tag、大小、单层 RootFS 等元数据完整保留，旧目录和报告未被当成镜像缓存一并移除。六份历史 workspace.tar 也仍在，独立 hash 全部匹配各自旧 prepared 记录；每份历史 prompt.original.txt 和 run_instance.log 均保留。

**当前任务可用性和实际删除集合 PASS**：对照更完整的
`disk-capacity-20260909T0800-docker.json`，处置前 114 个不同 image 中当前缺失的恰好就是这六个，其他 108 个仍存在。读取当前任务目录时，共 22 份 ready
prepared、23 份 ready runtime、31 份 OCI image metadata，加 core，去重 **77 个 image 全部 docker
inspect 成功**，与六个删除 ID 交集为空。5 个当前容器也没有引用这些旧 ID。原快照中的卷保留；原 5 个容器中 4 个仍在，另一项是明确带 FeatureBench/prepare/pytest 标签的任务容器，而非额外删除的用户容器。上述前后镜像集合核对支持本次没有扩大到未列明镜像；不将该时段正常 worker 生命周期变化混算为本次缓存处置。该 pytest 当前 prepared.json 已 ready=true，cleanup 明确记录上述同一 container
ID 为 removed，确认它按准备流程正常清理。

**第三次 OCI 清理 PASS**： `cache/oci/pruning/1788941196172048674.json` 独立 SHA 为
`065f86de0e161e4e6b8b24470bdba7f5595a9cbd6989d2279b78e49e03ebee9a`。记录 31 个 inspected
manifest 全部 loaded=true、protectedLayerCount=0、无 skipped；47 个展开 tar 的字节数独立求和为
**48,247,123,968 bytes（44.9336
GiB）**，等于 eligibleBytes/freedBytes，当前这 47 个 tar 均不存在。对应的 47 个压缩 blob 全部仍在，共 28,794,418,695
bytes，大小逐一匹配各固定 manifest；31 份 manifest/config 的 hash 及 image
metadata 均核对通过并仍保留。

清理实现仅对外部 cache/oci/layers 下的已识别非 symlink
tar 执行 unlink，取得全局 activity 独占锁并逐层取得锁；尚未 loaded 的 manifest 保护其 diff
ID 和压缩 digest。每个候选在删除前必须有可用且 SHA 符合 descriptor 的压缩源，压缩 blob 不在删除路径。因此此处回收的是可由保留压缩源重新展开的缓存。磁盘 freeBytes 的前后差受同时运行的准备/构建及 Docker 回收影响，不将该差值当成六个镜像单独精确释放的字节数。

## CooperBench 校准输出与不可变冻结引用复验

结论：**PASS，当前子项 must-fix 无**。只读复核适配器、公共选择逻辑、回归及已有真实报告；未重跑评分、容器或模型。当前 cooperbench.py
SHA 为 `2393fcfa9aa02252749f4ce1bcae9bfc71079776fcc2740f02e51464b5f625e0`。本节不代替 FeatureBench
F1、全量 30 题冻结或模型阶段验收。

- **输出生命周期 PASS**：main 将 calibrate 的 --output 传入实现，显式目录仅允许单题，reserve_report 在评分前原子拒绝已有报告；显式目录只写本次 calibration.json。缺省调用仍生成新的 attempt 目录，可更新兼容 latest 别名，但旧 attempt 不覆盖。真实 reuse.log 显示同一官方目录在 reserve_report 即遭 FileExistsError，原报告 hash 未变。
- **不可变引用 PASS**：公共 calibration_files 排除 parent 与 attempt_directory 不相同的别名路径，选择 generation 本体；根据路径、environment_kind 或 official_reference_report 区分 overlay，自定义的任务根内目录也能正确分类。回归同时覆盖 alias 排除、新失败 attempt 不被旧成功掩盖、旧 hash 保持和自选 overlay 目录。只读调用当前选择函数，15/15
  CooperBench 官方与 overlay 均返回其自身 attempt_directory 中的报告。
- **新机器标准路径可发现 PASS（代码范围）**：公共官方入口输出标准任务根下 official/UUID/calibration.json，overlay 从同一任务根递归查找官方不可变报告；没有旧 latest
  alias 时不要求先创建 alias。已有 alias 时只核对其对应原副本，再选择最新官方 generation。排除 overlays 目录及显式 runtime_overlay/official_reference_report 标记，避免把已完成 overlay 当官方来源。此次没有另建 fresh
  scorer 环境重跑；该结论依据当前无 alias 分支和标准路径构造，以及已有公共入口真实运行证据。
- **文档约束 PASS**：COOPERBENCH_PROGRESS 明确显式输出仅单题、目录不可复用、不会更新旧 alias，并要求可自动发现的官方输出位于该题标准校准根；任意根外目录不会被自动发现。RUNBOOK 标准官方→prepare→overlay 顺序与这些路径相符。

主证据 `runs/audits/cooperbench-calibration-output-20260909T081346Z/result.json` 独立 SHA 为
`e0dbbd5ad9942645e4c1dd622f701878d889a335a9122afab82d4a61895afb51`。dirty-equals 两次公共入口运行各 returncode=0/passed=true：新官方报告 SHA 为
`6a348780d47a28c1a6e49aa2849c84308546f0e720c303bb6dd6924c87368169`，当前最终 overlay 报告 SHA 为
`16e0d1980f17ad4462af2395f5ef0b4d9d46bc3e699fab87cba420d6fa5b62f3`。独立检查后者 official_reference_report/sha256 确实关联前者 immutable 报告，评分 image 为当前
`ed90a62ad0c1…`，公共选择函数也选中这两个新路径。

两次 baseline 均为每 feature 0 passed/1 failed，individual gold 分别 78/60
passed，combined 两 feature 均 passed；10 个评分容器 transport 清理全部 returncode=0。本次不重做此前已验收的评分语义，也不将公共 CLI 的 executed 字样单独当作通过。audit 中记录的 8 份既有 calibration、4 份既有 agent 报告 hash 独立重算均未变化；原 final 汇总引用的 15 份 calibration 和 15 份 agent 报告也全部匹配，四个冻结 runtime 脚本 hash 与原 final 元数据仍完全一致。

## FeatureBench 替换选题：Setuptools → Hatch

结论：**PASS（selection），允许继续 Hatch 下载、准备与官方校准；must-fix 无**。Hatch 的镜像下载、baseline/gold、sanitized/runtime、源码隔离、parity 和 UID 均仍
**pending**，本节不宣称环境已经可用。此替换发生于清单冻结及模型执行之前，依据官方初始环境的 P2P 缺陷；未以模型成功率挑题。验收方只读审查和更新本记录，不修复清单或重新执行评分。

**替换依据 PASS**：固定 Setuptools 题 `pypa__setuptools.d198e86f.test_bdist_wheel.51482fc6.lv1` 的
`20260909-official-01/calibration.json` 仍 status=failed，baseline.p2p_success=false，gold
resolved=true。2026-09-09 的原始 baseline 日志记录 mask 正常应用；原可见 test_setupcfg 的两个参数化 case 在
`due < date.today()` 分支调用 `_should_enforce` 时报 NameError，继而 DID NOT
WARN。固定数据的官方 mask 确实删除了该函数定义；该 P2P 文件 baseline 为 **65 passed/2
failed**，gold 为 **67
passed**。这是日期条件触发后的 mask 副作用，不是缺失日志或适配器把失败误记成功；没有通过改日期、补回 mask 内容或放宽 P2P 来绕过。旧失败报告独立 SHA 为
`1c3cb3d57a7a2a2f6810198c2f62ded1173c9c7a4474aaa0a3ccbcaf06cdf71f`，全部原评分证据保留，旧镜像锁对象与 before
lock 相同，retiredTasks 保存旧任务及替换原因。

**同仓替代调查 PASS**：独立读取并验证固定数据 fast/full/lite
JSON 的锁定 hash。Setuptools 在 fast/full 各出现 1 次、lite
0 次，跨 split 去重只有上述同一 instance，没有被遗漏的另一同仓候选；不能把同一 instance 在两个 split 的出现算两道题。

**Hatch 原题与实质分工 PASS**：新题 `pypa__hatch.ff4b4040.test_fmt.782c88a8.lv1`
来自相同固定数据 revision
`76b4a4566e04f4bcc13c35125d4f301791efa736`，fast/full 的该原始 row 完全一致。原 prompt 为 **36,650
UTF-8 bytes**，SHA 为
`df18a163086a7175ee0d21f75373fdbecf01759ee8b4a35f25df444b9f9a8645`；起始 commit 为
`ff4b4040fe84c9a5911137791695380d976577dc`，均与选题记录精确匹配。分工来自原始接口描述，具有不同可交付行为：

- 项目配置、环境查找/准备与 plugin 配置：包括配置继承/校验、项目位置与 metadata、环境解析和初始化。
- 格式化执行与 Ruff 配置：包括 shell 错误处理、平台参数 quoting、配置路径选择与 stable/preview 配置写入。

两者可依照原题给定 EnvironmentInterface/配置契约分别推进，最终由 parent 集成环境配置与格式化命令；不是把同一个实现重复分配，也不是仅按文件数量宣称可并行。这些选题分工描述仍仅供审计，不替换原 prompt 或注入参考解。

**版本及清单范围 PASS**：新清单仍恰好 15 个不同 task、15 个不同 repo、fast Level
1；相对 before 仅删除 Setuptools、加入 Hatch，其他 14 条完整对象逐字段不变。新清单 SHA
`e449fc171368352865766b2e6df959831b022b8cb51a71ab8dd9d6d9baf789c5`
与 lock.selectionSha256 相同；selectionStatus 仍 provisional，套件 freeze 锁尚不存在。before 清单 SHA 为
`7223d1cfac0750f8a91569c33a9259a019df480b4402b2b168a1649602daeaea`，与归档 before
lock 所记值一致，归档文件完整保留。

**官方镜像固定 PASS（metadata 范围）**：image 名与原 row.image_name 相同，固定 manifest digest 为
`70c443280ebe701fe0b6ca24d22c139f3b5c92817a5c1c16c2fc5762b67a4fb1`，config digest为
`f205cd379edfada5909f8bf7a1a9ce256efdd4d1132de0ef8802ef58c19f955a`。本地缓存的两份原始文件 hash 独立核对通过，config 为 linux/amd64，19 个 layer 与 diff
ID 数量一致，压缩 descriptor 总量 10,360,738,559
bytes；原 repo_settings 指定 python310，未要求 GPU。这只证明待下载目标固定，不代表所有 blob 已下载或镜像已经 load。

替换主证据位于
`runs/audits/featurebench-selection-replacement-01/replacement.json`，本轮审查时 SHA 为
`a04a38b4eeb48957ab00a20bae2eb6dd4d2cec5b8145dbeed072c4ddb1e72c0e`。后续环境阶段须用该新清单覆盖 Hatch，不把退休题的成功步骤或旧清单计数转记到新题。

## FeatureBench F1：Pandas v4 实际准备、parity 与 UID 复验

结论：**PASS，F1 关闭，当前子项 must-fix 无**。此前 v4 代码预审的 pending 实际镜像证据现已补齐；本次只读检查现有档案、报告、固定解析器和 Docker
image metadata，未重跑校准或模型。此结论仅覆盖 Pandas 修复及 F1 影响范围，不代表全部 15 题环境通过。

主索引 `runs/calibration/featurebench/pandas-v4-index.json` 为 completed/passed=true，独立 SHA 为
`ca0b723eb047dede44f27b8b40478233f1560326c52f1440b4c38d47ab92796a`。当前 prepared.json SHA 为
`e998901d0fa94960ffd498694bf51cc3b6fa34a0819d9f0d4dd7ec22206983a4`，ready=true、auditVersion=4；prepared
image 为 `132bd64949887326a10bf1a8d1e71749f5f0fe4aa3aca17e0245587e9e53976c`，runtime image 为
`10d1dfb2b1a9edf3389a69414ad5df400bf4a191c60ede1b586b7bb341b34d9f`。runtime 关联该 prepared
SHA、相同基线 commit、core `20a32f60311a…`
和此前已冻结的四个 runtime 脚本 hash，公共 provenance 检查通过。两 image 实际可 inspect，均为 linux/amd64；runtime 的 layer 前缀与这一 prepared
image 对应。

**源码副本修复 PASS**：独立读取当前 workspace.tar，SHA 为
`58d67a0c0eaafebcd7f343bf685707934a4a69730611781f92d017a565405c7d`。
`build/cp311/pandas/__init__.py` 在归档中是到 `/testbed/pandas/__init__.py`
的 symlink；canonical 文件为 8,002 bytes，SHA
`39baa7954721021445132b4c2c5f0cd40a98f8d71645a6d57658e7b89622f263`。此前泄漏的 487-byte 删除块（SHA
`a17eddb55b4625590d358c3e209e14e2756ecd1cd96c5ea0f3ed0f2b1cc81ef9`）在 canonical 中不存在，链接因此不会提供该旧块。核对使用字节/hash，不输出参考实现。build 中 44 个编译扩展逐个与旧归档比较，全部字节相同，F2P 文件仍不可见。

prepared
audit 确实经过 v4 原始 generic 文件 hash 匹配分支：matchedMaskedGenericCopies 记录 build/cp311/pandas 的
`__init__.py`，preservedCompiledPackages 记录 44 个扩展、1 个链接 Python 文件；唯一 skipped 同名目录为 hypothesis/extra/pandas，它是内容不同的集成模块。prepared 阶段上限 2
GiB，记录 peak 598,761,472 bytes、OOM 计数为 0，准备容器已移除。旧 v3
prepared、归档和失败来源仍在 preparation-history 中，未以重写旧证据替代新 generation。

**官方评分等价 PASS**：当前 overlay 报告
`overlays/20260909-runtime-v4-10d1dfb2b1a9/calibration.json` 独立 SHA 为
`e0a6899ea30f82441ae1482d4687bce2efe544b8acbd7d5b69d90a26a96ae894`，指向当前 runtime。验收方用固定上游 parse_test_outputs 重新解析已有原始日志，得到：

| 模式     | F2P       | P2P          | 与原官方映射相同 |
| -------- | --------- | ------------ | ---------------- |
| baseline | 1 ERROR   | 1,887 PASSED | 是               |
| gold     | 11 PASSED | 1,887 PASSED | 是               |

baseline collection error 是原官方起始状态同样存在的预期失败，不记为成功。baseline 177.579 秒、gold
168.602 秒，均无评分 transport error，两个容器清理为 removed。

**真实用户环境 PASS**：当前
`overlays/20260909-agent-v4-10d1dfb2b1a9-9f38b28c/agent-environment.json` SHA 为
`9db37330521b456e111c256cf552f47319cd17423c691d934ed35e80e37e0074`，8 项检查全通过。真实 launcher 可启动 OpenCode
1.18.18；后续探测均 UID 10001、NNP=1，原 5 个 P2P 文件可读、workspace 可写、私有依赖不可读。target
Python 为 3.11.14，真实 Pandas import 触发 editable Ninja
154 步重建（155.829 秒）后仍从 canonical 路径导入；重建后另行验证 build init 与 masked
canonical 字节相同。此处证明的是重建后内容相等，不把归档时的 symlink 类型误说成重建后仍必然不变。hypothesis 集成和 44 个扩展均保留，pytest 可用、tracked
worktree 未变，检查容器已移除。公共当前报告选择及 agent-environment 校验均通过，现场无该任务遗留容器。

**限定重做范围 PASS**：更新后的 `runs/audits/featurebench-generic-mask-impact.json` SHA 为
`a85d3ea91581cf5700c8b4591d6272389f10c492b641b110fbc2f6da6261e565`，关联当时当前清单
`09cae6a21e3197258e1916a53f3aca6ec1e49c3ea48ff999e8d2b95c7092e592`，15 条 task 全匹配，包括 Hatch 和新 Pydantic
Pipeline；两退休题单列，旧 audit 快照仍存在。验收方独立重算当前固定 mask/F2P 的根相对 generic 路径，仍只有 Pandas 与 Xarray 受旧 generic 排除规则覆盖。Xarray 当前 v3 没有 skipped 同名副本，prepared
SHA 与报告一致；其余 13 题不存在这类根路径。Hatch 的嵌套 internal/**init**.py 不属于该旧排除条件。这为只重做 Pandas 提供范围依据；该审计不代替每题完整源码隔离、准备或 runtime 验证。

## FeatureBench 替换选题：Pydantic Deprecated Fields → Pipeline（初审）

结论：**FAIL（当前分工 metadata），其余 selection 核对 PASS**。发现一项 must-fix
**F2：第二组实质工作边界不足**；任务本身可以保留，先明确两组职责再关闭 selection 验收。新题官方校准、sanitized/runtime、parity 与 UID 全部
**pending**。此次只读审查固定数据、原 prompt 和已存在失败证据，无模型、无新增评分或容器调用。

**F2 证据及关闭条件**：当时清单 decomposition.parts 将 Pipeline core-schema construction、constraint
application 与 TypeAdapter JSON export 全部分给第一组；第二组只列 fluent
comparison/membership/predicate、datetime/string 方法。原 prompt 明确 str*lower/str_strip 等封装内置变换，eq/in*/timezone 等添加约束，而约束语义执行已被第一组包揽。不能仅按 convenience
API 数量认定第二组符合交接文档第 103 行的“至少两个实质子任务”要求。

应使第二组明确拥有原 prompt 已要求的约束执行行为，例如 `_apply_constraint` / `_check_func`
及对应 fluent API；第一组保留 pipeline 步骤编译/组合和 TypeAdapter
JSON 导出，约定以已有 CoreSchema/constraint 接口集成。其他能说明同等实质边界的分工也可接受。该修正仅限选题审计 metadata，不修改原题字节，不给 agent 注入分工或参考方案；验收方不负责修改。原始 Pipeline 需求包含这些独立接口，因此无需因本项再更换仓库或任务。

**替换原因 PASS**：旧题 `pydantic__pydantic.e1dcaf9e.test_deprecated_fields.40a2ec54.lv1`
的官方 baseline 确有唯一 P2P 失败
`tests/test_missing_sentinel.py::test_missing_sentinel_json_schema`。固定 row.patch 第 752 行删除 computed_field_schema 定义，patch
SHA
`bd5779565c96bc943bd521097eda353150de8a60f29f0bf5ed6f2d1a733c8cb3`；mask 应用成功，原测试在 schema
dispatch 中报缺少此方法的 AttributeError/TypeError。gold 后该 case 通过。5 个原 P2P 文件 baseline/gold 全部实际执行，无缺失文件或评分 transport
error，两容器都已 removed。

原 raw P2P 总量为 52 collected：baseline 49 passed/1 failed/1 xfailed/1 skipped，gold 50 passed/1
xfailed/1 skipped；官方 P2P 相应为 50 success/1 failure → 51 success/0
failure，因为预期 xfail 计入官方 success，skip 不计入。官方 F2P 为 0 success/12 failure → 12
success/0 failure，没有放宽 P2P 来规避问题。旧 calibration SHA 为
`242c12306b3151a6f22160e019dde8bc8c5070923255fbd9d6d8ff2e45d04ada`，独立诊断 audit SHA 为
`5ce236486a0e9dd69241759e033aec62ec6d673ebd35efdbcad63b31981cd51b`；其中关联的 20 个文件 hash 独立重算全匹配，失败原件仍保留。

**候选及版本 PASS**：固定 fast/full 各有 5 个 Pydantic
instance，lite 有 1 个，跨 split 去重共 5 个，逐个枚举与提案相符。新题
`pydantic__pydantic.e1dcaf9e.test_pipeline.c9b08962.lv1` 的 fast/full 原 row 完全相同，prompt
**37,123 UTF-8 bytes**，SHA
`86d954703a5da7abb242cf06ea377a9e4d1060c95ed4310d8b7552e2b84ef7d9`，与清单及提案相同。同仓起点均为
`e1dcaf9e68fc89731b45235e53245447edf35084`，固定官方 manifest 为
`755c424c73170faf66d88006022ed2733f8e269446f330f301d762b0d0ab7d6b`，config 为
`6d4e96aa005ff35925cd2d374fa12c71cd025d789b3b298b903107b08325f307`；两原始文件 hash 均核对通过，linux/amd64、19 层、压缩总量 10,978,895,720
bytes，python312，无 GPU。官方 image 锁对象与 before 完全相同，已有官方 imageId 为
`5350dd2807bf…`。共用官方镜像仅免去新增官方下载，不能复用旧题 calibration 作为新题通过证据。

**一换一和留档 PASS**：before 清单 SHA 为
`e449fc171368352865766b2e6df959831b022b8cb51a71ab8dd9d6d9baf789c5`，before lock SHA 为
`d79b0d6a0a197d35bcd6745a40d3fba268d0650b904fce5947494a7e366aafee`，两归档仍存在。初审新清单 SHA 为
`09cae6a21e3197258e1916a53f3aca6ec1e49c3ea48ff999e8d2b95c7092e592`，与 lock/proposal 相符；只移除旧 Deprecated
Fields、加入 Pipeline，其余 14 条完整对象逐字段不变，仍恰好 15 tasks、15 repos、fast Level
1，selection 保持 provisional。retiredTasks 保留旧对象、失败路径及替换理由。后续 F2
metadata 修改应同步清单 hash 及相关当前审计关联，并保留这份初审提案以供追溯。

### F2 分工 metadata 复验

结论：**PASS，F2 关闭，Pydantic Pipeline
selection 通过；must-fix 无**。允许继续新题官方校准与准备，环境完整性仍 pending，不复用旧题校准结果。

新分工将 pipeline 步骤编译/组合、TypeAdapter JSON 导出交给第一组，将原 prompt 中的
`_apply_constraint` / `_check_func` 约束执行及对应 fluent
API 交给第二组。两组现在分别拥有步骤组合与约束执行这两类实质行为，通过 CoreSchema/constraint 接口集成；第二组不再仅以 convenience
wrapper 数量作为入选依据。

独立核对只有新题 selectionReason/decomposition 改变，原 prompt 仍为 37,123 bytes，SHA
`86d954703a5da7abb242cf06ea377a9e4d1060c95ed4310d8b7552e2b84ef7d9`，另外 14 条 task 完整对象不变。当前清单、lock 和 replacement-02 提案共同关联 SHA
`0ee1b5b78e5c61bef0e76d8506f4dd7c85c2bd0b7829e5f03f0a3adb4f588f5d`。提案当前 SHA 为
`2e2ea314279a8f57fa164dc3242ed7480acc1c8ad393b5f6e6f271e4c491be00`；初审清单、锁和提案已分别保存为 before-decomposition-review 三份 JSON，初审清单 SHA 仍为
`09cae6a2…92e592`，归档锁/提案关联匹配。

当前 F1 影响审计亦同步至新清单，SHA 为
`6a9123995c41f49d7d50f80a44cc4603938f7331e0db313e96d3d93635d16642`；15 个 task
ID 与当前清单完全相同，只有 Pandas/Xarray 根 generic 路径，上一代快照存在。本节只关闭分工记录问题及相应 hash 关联，不改变上节已验证的原失败、固定镜像和一换一结论，也不宣称新题官方/overlay/UID 或整套 30 题已通过。

## FeatureBench 替换选题：Pydantic Pipeline → Sympy Matrix Inverse

结论：**PASS（selection），当前 must-fix 无**。可以继续新 Sympy
inverse 官方校准与准备；其 baseline/gold、sanitized/runtime、parity、UID 均仍
**pending**。本轮只读核对原题、已有失败日志、版本与审计关联，未新增模型、校准或容器运行。

**调整选题策略 PASS**：交接文档第 99–117 行要求 15 个独立任务、多个仓库/功能类型，且不能以同一功能 Level
1/2 变体重复计数；并未要求一仓一题。原来 15 仓是实施侧初选偏好。当前仍为 15 个 fast Level
1 独立任务，覆盖 14 仓，明确记录策略调整，未降低实质分工或无模型校准要求。

**两道 Sympy 题的独立性 PASS**：现有 `sympy__sympy.c1097516.test_puiseux.cd575f09.lv1`
要求 PythonMPQ 算术及 Puiseux 级数/多项式环，F2P 为 `sympy/polys/tests/test_puiseux.py`；新题
`sympy__sympy.c1097516.test_inverse.c240ffe7.lv1` 要求 DomainMatrix 与矩阵求逆，F2P 为
`sympy/polys/matrices/tests/test_inverse.py`。两者的原始需求与功能不同，均为 Level
1，不是同一功能的难度变体。mask 文件范围在 pythonmpq.py 有交集，因此不声称所有底层源码完全无交集；该共同依赖不使两个不同功能/F2P 变成同一道题。

**实质分工 PASS**：原 prompt 本身列出 DomainMatrix 的域/shape/表示校验、分母 gcd 消约与 canonical
unit、伴随/逆接口，以及独立 `ddm_iinv` 和 `all_close`
接口。第一组负责矩阵代数契约及分母/伴随行为；第二组负责域上稠密逆算法的输出更新、奇异/非方阵等错误行为，以及递归近似比较的容差、同类型容器和表达式结构语义。两组均有实质实现，按既有矩阵表示与域契约集成，并非把轻量 wrapper 数量当成另一工作流。分工仍只用于选题审计，不改变原始 agent
prompt。

**原题与环境固定 PASS**：新题取自锁定 revision `76b4a4566e04f4bcc13c35125d4f301791efa736`
的 fast.json；prompt 为 **28,074 UTF-8 bytes**，SHA
`b37f91d74d0dc027f6b5daab933f5313c92c978f0080c49a50377aefb331ff7d`，与当前清单/提案相同。fast/full 的该 row 原 prompt、patch、F2P/P2P 相同，但 repo_settings 的 CUDA
visible
devices 不同（fast 为 null，full 为 6,7），故不把整个 row 宣称完全相等；当前明确锁定 fast。起点
`c1097516c793b0364c4f3fe2eeb66b15a94eedfd`
与现有 Sympy 相同，原设置 python311，所选 fast 无 CUDA 或特殊 capability 要求。

固定官方 manifest SHA 为 `207ff124011e74d2b6abbdce2f8d3244546949cd0abfb7949d7dd414368f8935`，config
SHA 为
`677064f1d1c3ba2ab111781c8fdf6d784719c03e975086e1dce45cac16b57c6a`，本地原始文件 hash 独立匹配；linux/amd64、19
layers、压缩总量 10,648,078,585 bytes。image 锁对象与 before 相同，沿用已加载的官方 imageId
`da73b125fd35…`，不新增官方镜像下载。共享官方 image 不意味着可以共享不同题的 prepared、gold 或 calibration 报告。

**Pipeline 退休原因及原失败保留 PASS**：旧题新 attempt
`20260909-pydantic-replacement-01/calibration.json` status=failed/passed=false，SHA
`7873f897e9e895cf70cb6ee6148faba7c8b572b119d8df5bbd0326dac02a7191`。baseline/gold 均成功应用官方 mask、5 份 P2P 文件全部执行、error=null、容器 removed。baseline 的 test_create_model 三个 JSON-schema
case 失败，原始日志均显示缺失 int_schema；固定 mask 第 551 行确实删除该定义，mask SHA 为
`09dfa367b55a748f842d7fbcb80c89adfed90cfd856f24887504b8887baa3106`。官方计数为 F2P **0 success/64
failure → 64 success/0 failure**，P2P **44 success/3 failure → 47 success/0 failure**；raw
test_create_model 为 25 passed/3 failed → 28 passed，其他四份 P2P 分别 8、2、8、1
passed，前后相同。因此先前 selection PASS 未被误当成环境 PASS，也没有放宽 P2P 门禁。

同仓剩余候选的进度概述仅是静态风险调查，不能记为实际 calibration 失败。验收方独立确认固定 fast 中余下 experimental_arguments_schema、titles、types_self 三题，原 prompt 分工范围及 mask 中存在 schema 方法删除可由静态材料核对；此次不要求穷尽所有同仓评分才能调整一仓一题偏好。当前 replacement-03 本体尚无逐候选调查明细，故不将那部分概述当成已完成逐候选校准证据。未选择 Optuna 或 full 题。

**一换一与审计关联 PASS**：新清单、lock、提案同 SHA
`62c8644aa771a889d61dda4a94c5f5ad973e25949034b3d0fb5c021045b44185`，selectedCount=15、repositoryCount=14，selection 保持 provisional。只移除 Pipeline、加入 inverse，其他 14 个 task 完整对象逐字段不变。before 清单 SHA 为
`0ee1b5b78e5c61bef0e76d8506f4dd7c85c2bd0b7829e5f03f0a3adb4f588f5d`，before lock SHA 为
`9cf584989236b45624e2de802002ebf00ff83926e5314b99010af935b0542c70`，归档仍存在。retiredTasks 包含 Setuptools、Deprecated
Fields、Pipeline 三个旧失败任务及各自 calibration 原路径，历史分工记录未删除。

replacement-03 提案本轮 SHA 为
`bcb5685058f1d6b63acde837deddfefe05aafa0cd2585f466a0cfb9c39801130`。当前 generic
mask 影响审计 SHA 为
`0fde22993f724dd76a2464f9454969a95e05c4fa429821e22af1c991e9897dca`，清单 SHA 及 15 个 task
ID 全匹配，三退休题单列，上一代快照存在；根 generic 路径仍只涉及 Pandas/Xarray。新 inverse 不继承退休题的任何“已通过”计数；全部环境与最终 30 题冻结仍待各自后续验收。

## 旧 Packaging v2 BuildKit 缓存定向回收范围验收

结论：**PASS（46 个精确 ID 的范围提案），must-fix 无**。可以按
`runs/audits/packaging-v2-buildkit-cache-20260909T084730Z/candidate-cache-ids-leaf-first.json`
给定的 46 个 ID 子节点在先、父节点在后的顺序定向回收；执行方仍须保持提案已规定的逐 ID 当前属性/图关系重核，不扩大到新节点、相邻根、共享 source/core、开发缓存或全局 prune。本验收只读取文件、官方 CLI 文档、du 和 image
inspect，**没有删除缓存、镜像或其他资源，也没有进行 build、评分或模型调用**。

主 summary.json 独立 SHA 为
`5cf0d1d98abbf449b4aa07f4090dfd6d3580be961e1deeca2d7cbbe59869821a`；所列 10 份 evidenceFiles
hash 全部独立匹配。候选 ID 清单 SHA 为
`f982dc0f85b7bd5f61b571ce678cfa590b32b810695a3d2473f59136eba0870b`。

**缓存图与属性 PASS**：从原始 buildx-du.jsonl 的 1,017 个不同 ID 独立重建 Parents 图，从根
`wrbzu78632ky466txffym1622`
得到的完整后代闭包恰好是候选 46 条，没有组外父节点或子节点。只有一个根、三个叶，给定顺序对每条边均满足 child 在 parent 之前。46 条全部 Type=regular、Reclaimable=true、Shared=false、Mutable=false。独立 Docker
engine 原始记录的 Parents、InUse=false、Shared=false 也匹配，精确 Size 求和为 **8,604,481,154
bytes（8.01355
GiB）**。组外 971 条原记录，包括 10 条 source.local、1 条 exec.cachemount 和其他 regular 缓存，均不在候选集合。

复核时重新读取 default
builder 的真实 du，已增长为 1,036 条，46 条候选仍全部存在，CreatedAt/Parents/Reclaimable/Shared/Mutable/Type 与原证据完全相同，新增记录无一成为组外 child。单独以
`id=rai21bq599lickttuoqszi50s`
查询只返回该完整 ID。此为当前快照证据，不取代执行每一步前的重核；并行准备可能继续产生新缓存。

**历史归属 PASS（多证据推断）**：三个已完成 BuildKit
history 的 Context 都是该题 runtime-overlay，Materials 均含退休 prepared image
`9a4ccc4057cf…`，Attachments分别包含 `43c8899ea8fd…`、`accbbd5c6e52…`、`4c9e54c82d24…`
这三个已退休 output。验收方独立归一化时区并保留纳秒，三个叶 cache
CreatedAt 分别与 eviction-03 留存的对应 image
Created 完全相同；其 18/18/19 节点祖先链汇合于同一个候选根，全部 46 条的创建时间都落在上述三次构建区间内。

根 Description 为空，du 没有直接 source-image-digest 字段，故根到旧 prepared 的映射仍是 Context/Materials/Attachments、纳秒时间及闭包共同支持的推断。根 Size
6,902,673,073 bytes 与旧 prepared image Size 6,902,673,947 bytes 相差 874
bytes，仅可作为量级一致的旁证，不能声称这两个不同记账值完全相等。当前 Packaging v3 prepared
`57241af46675…`、runtime `b8d0884a25d1…` 与公共 core `20a32f60311a…` 现场 image
inspect 成功；当前缓存图没有把这些后续构建接入候选闭包。

**精确 filter 范围 PASS，删除效果未实测**：Docker 官方文档将 `=` 定义为 equality，prune 支持 id
selector，而 du 使用同一 filter 接口；多 filter 条件为 AND。见
[prune filter](https://docs.docker.com/reference/cli/docker/buildx/prune/#provide-filter-values---filter)
及
[du filter](https://docs.docker.com/reference/cli/docker/buildx/du/#provide-filter-values---filter)。已有真实 du 单 ID、锚定正则以及 46
ID 锚定集合探测均返回预期集合；验收方独立核对 46
ID 探测记录的全部属性与原表相符。只以完整 ID 调用提案中的 prune 命令，不使用 parents 扩展、description/age/min-free-space 等更宽筛选。

guarded-id-filter-verification.json 的 exactSetMatch=false 是保留的失败语法探测：private=true/inuse=false/mutable=false 在本地 CLI 返回空集，不能把这份文件当成通过证据。后续不带这些 boolean
equality 的精确 ID 集合探测才是成功证据；提案已明确改为执行前直接检查 JSON 属性。此轮只以 du 验证筛选，没有拿真实 prune 做试删除；8.01355
GiB 是 BuildKit 报告量，不能保证 df 即刻增加同样字节，也不能把先前旧镜像的虚拟大小再加计一次。

### image-eviction-02/03 的当前镜像与恢复材料抽核

结论：**PASS（本次抽核范围）**，不是重新实施或全面重放两次删除。02 audit SHA 为
`57f9b0d8de9357257346e1326ab3a31fab3e1b8f9bab773449baac34bd053f68`，03 audit SHA 为
`861be82aa40ba48d961aaed0e9ff8307e97f2f1fcbefc89221bdda50f6e2ca63`，均 complete。02 的旧 Pandas v3
runtime/prepared ownership 报告 SHA 仍匹配；03 前置范围 summary SHA
`45a3ef05e8ab5790b02446c1980ca5dc82927b8386c2a2957a17463888520e31`
与删除报告关联匹配，其 8 个绝对路径历史/当前文件 hash 全部保持。

当前所有 ready task-workspace
prepared/runtime 引用中没有这 7 个退休 image，容器列表也没有对应 image 引用；现场抽查当前 Packaging
v3、Pandas v4 的两组 prepared/
runtime 和公共 core 共 5 个 image 全部可 inspect。旧 Packaging 与 Pandas
workspace 归档仍在，独立流式 SHA 与各自历史 prepared 所记 workspaceArchiveSha256 一致；旧校准、初始化日志和原 prompt 随历史目录保留，Setuptools 原失败报告也仍存在。

Setuptools 压缩恢复校验报告 SHA 为
`44ac5aed0b2ac1b1adf14b577e6b93c806a192097b4fa0afafcc38b2e363d851`，原先 21 项完整 hash 检查均 passed。此次独立确认 manifest、config、19 个压缩 layer 全部仍在且大小匹配，压缩层共 10,286,099,706
bytes；重新计算 manifest/config 及三个约 29.5/47.6/ 48.1 MB 压缩层 SHA 全通过，config
diff_ids 与删除前 image RootFS 完全相同。这是保留完整清单及部分字节重验，**未在本轮重算全部约 10
GB 压缩数据的 SHA，亦未重新 load 或重建旧镜像**。恢复所需额外展开/Docker 空间不在本次验收中保证。

### Packaging v2 46-ID 回收执行后复验

结论：**PASS（已执行结果），must-fix 无**。验收方没有执行删除；只读审查执行脚本、新报告并重新查询当前 du/image 列表。执行报告
`runs/audits/retired-packaging-buildkit-eviction-04.json` 为 completed，SHA 为
`1056c70c86f93ed7da40d7428dc003b7d413189815a75c9d292844cd38350095`。报告 sourceSha256 与已验收提案 summary 相同，46 个 candidate
ID 及 action 顺序与批准范围清单完全一致。实际执行脚本 `/tmp/evict-retired-packaging-buildkit.py`
SHA 为 `7a27a52724bd6c53933b33d85683fb94c805b39f2f3532dd020acfb34dc95682`。

脚本在开始时检查全部源证据 hash、完整候选集合及组外 child；每步重新读取完整 id
equality 结果并检查 CreatedAt/Parents、reclaimable/private/immutable，随后只向该完整 ID 发出 prune。实际用了 --force，它在此 CLI 中只是跳过交互确认，不扩展 filter 范围；未使用 --all、parents 或广泛空间/年龄条件。

独立重算报告前后集合：**1,036 →
990 条，差集恰好是这 46 条候选**，无其他 cache 消失，46 个 action 均 removed；每步 before 只有目标 ID，属性与原提案一致，after 均为空。unexpectedRemovedCacheIds、unexpectedRemovedImageIds 和 metadataChangedDuringConcurrentPreparation 都为空。

验收方随后现场只读重查仍为 990 条，候选全部不存在，原 990 条组外缓存全部保留。删除前的 114 个 image
ID 现场全在，当前共 115 个 image（并行任务可新增镜像）。保存的 55 份当前 prepared/runtime metadata
SHA 也逐一重算全相同；这覆盖的是该报告纳入的现有文件，不将尚未存在的后续准备文件算入分母。

报告的 free bytes 为 88,353,390,592 → 109,644,746,752，净差 21,291,356,160
bytes。此差值发生于并行准备期间，仅记录文件系统净变化，不能归因为该 8.01355 GiB
cache 组单独释放了相同字节。历史提案、BuildKit history、退休 image
metadata、压缩源和全部评分/运行报告均不在执行脚本的删除路径内。

## 旧 Packaging v1 与 Pandas v3 的 62-ID 缓存回收范围验收

结论：**PASS（62 个精确 ID 的范围提案），must-fix 无**。可按两组各自既定 leaf-first 顺序定向回收，执行前继续逐 ID 重核原属性及闭包；不扩大到其他旧镜像的近似大小缓存、共享根或当前任务缓存。本轮验收只读文件、du 和 image
inspect，未执行删除、build、容器或模型调用。删除结果待执行后单独验收。

主证据 `runs/audits/eviction01-02-buildkit-cache-20260909T090143Z/summary.json` 的独立 SHA 为
`f2ba5674c20921eaf7817eebd4b1f539de6fa345304863db6e757bedef7f0917`；其 9 个 evidenceSha256 路径全匹配。精确 ID/顺序文件 SHA 为
`588436d021d3d44d9a534160099e12710bf70ff0acf0e64da98a64d350a63472`。

**精确图范围 PASS**：验收方从复用的原始完整 du/engine metadata 独立重建父子图：

| 组           | 根 ID                     | 完整闭包 | 叶数 | Engine Size 求和    |
| ------------ | ------------------------- | -------- | ---- | ------------------- |
| Packaging v1 | td16ehj1ac0oqxv1qi355wiu5 | 43       | 3    | 9,894,344,490 bytes |
| Pandas v3    | iieaj2ye3jtflme7tapjpfzlm | 19       | 1    | 9,409,364,368 bytes |

两组互不重叠，共 62 条、19,303,708,858 bytes（约 17.978
GiB），均无组外 parent 或 child。每条边的 child 都在给定顺序中早于 parent。62 条全部 regular、Reclaimable=true、Shared=false、Mutable=false；engine 的 InUse=false/Shared=false 也匹配。descendants、fresh-candidate-records 与 fresh-target-du 的 ID 集合和 Parents/CreatedAt/属性全部一致，62-ID 筛选没有混入别的记录。

随后现场重新查询完整 du，共 1,009 条：两组仍为上述精确闭包，62 条均存在且原属性完全未变，没有新接入的组外 child。此事实只适用于本次快照，不把持续运行中的 builder 状态视为永久冻结。精确 id
equality 筛选的 CLI 语义已在前一节审查；此次仍仅对明列完整 ID 使用该筛选，不以 root/parents 选择器自动扩展删除范围。

**归属证据 PASS，明确强弱边界**：Packaging 历史 Dockerfile 的 FROM 固定为退休 prepared
`d648cec3d91f…`；归档 build.log 第 17/100/195 行分别固定三次构建的同一 source，第 75/170/271 行固定 output
`ca4465b5020c…`、`edea48371cd8…`、
`86a0b6b837ae…`。三条 cache 分支都回到同一旧根，叶的 14/18/18 步描述也与对应构建形态一致。第三次仍有 completed
BuildKit history `2ce1nm8icizcfsnxy6h9endp0`，Context 为 Packaging
runtime-overlay，Materials 含该 source，Attachments 含最后 output，保留 runtime.json 亦指向它。

Packaging 前两次已无现存 BuildKit
history，故只按归档输入/输出日志和共同图结构关联，**不宣称三次都有独立的 image
Created 纳秒映射**。Pandas 则有 completed history
`e8913w06itv3pb79uhmkb519r`，Context/Materials/Attachments 分别指向 Pandas
runtime-overlay、旧 prepared `7fe37ddf95ef…` 和旧 runtime `14337c345616…`；叶
`dszi3fpxzrkilqpzub18vxkk5` CreatedAt 经时区与纳秒归一化后，精确等于 eviction-02 保留的 output image
Created。

两个 Description 为空的根都没有 Docker 提供的直接 source-digest 字段，映射仍是上述历史和图关系支持的推断。root
Size 与退休 image Size 分别相差 874/872
bytes，与元数据量级相符，但未单独证明差值就是某项元数据构成，不能单靠近似大小归属。

**当前引用与明确排除 PASS**：现场只读 inspect 全部 116 个现存镜像的 RootFS，旧 Packaging source
layer `f844a458abd6…` 和 Pandas source layer `558d58bbfd96…`
均无任何 image 引用；两 source 加四个旧 output 共 6 个 image 均已不在，当前 ready prepared/runtime
metadata 无对应引用。这样避免仅凭历史“已退休”标签作判断。

近似大小的 Metaflow 根 `rx2j5er8avu0tas6gcy1u96ws` 和 Meson 根 `iz4sppgk02wfmix94tnsc3xd6`
现场仍 Shared=true，当前 prepared `1c86b20d2801…` / `bef3008e60f0…`
均存在且 RootFS 与排除记录一致；两根均不在候选集合。eviction-01 其余 5 个旧 sanitized
image 没有在本提案获得回收资格，不能从“大小接近”或“以前删过对应镜像”推导新的缓存删除授权。core、source.local、exec.cachemount、开发缓存、当前 prepared/runtime、history、压缩 blobs、锁和报告继续在范围之外。17.978
GiB 是缓存报告量，实际 df 净变化受去重及并行准备影响。

### 两组 62-ID 回收执行后复验

结论：**PASS（已执行结果），must-fix 无**。执行报告
`runs/audits/retired-packaging-v1-pandas-v3-buildkit-eviction-05.json` SHA 为
`df6d0ec33551c5e91892aef837c6b82becdc48eabb1adbfb18173c5c4361986d`，completed。sourceSha256 与上述提案相同，62 个 action 与原两组 ID/leaf-first 顺序逐一相同，每步 before 属性与提案匹配，均 removed、after 为空。执行脚本 SHA 为
`585475737ca59f6c6ceb7883323320131ebdcd6d7a44d2a700b133899f96f229`；相对前次已审脚本，仅改变固定证据源/hash、两组清单读取与 62 条计数，仍逐完整 ID 操作。

报告集合独立重算为 **1,009 →
947 条，差集恰好是候选 62 条**。组外缓存、image 无意外消失；本次实际纳入 57 份现有 prepared/runtime
metadata，现场重算 SHA
57/57 不变。验收方另行只读查询时当前 du 已变为 965 条，候选仍全部不在，删除前 116 个 image 全部保留（当前 117 个）。有三个在执行报告终点仍存在的组外 cache
ID 随后不再列出：`orc1s2l6o8vd6r4maetgls80t`、`mh9vxcyrdblh0dm3g8gwsk51j`、
`6aze9h68ejwgj2tir0nlnk825`。不能将这一较晚快照说成原组外记录全部仍在；其变化不在 62 次精确操作的已记录差集中，后续归属核对另记，不反向覆盖执行结束快照。

free bytes 为 76,223,315,968 → 123,775,156,224，净差 47,551,840,256
bytes。仅记录并行准备期间文件系统净变化，不将它归因成这两组缓存单独释放的量。验收方未执行或重放删除，所有源提案、归档和报告继续保留。

较晚快照的三个组外变化已只读分类：原完整 du 明确三者均 Mutable=true、Type=source.local，分别是两个 local
context（4,096/28,672 bytes）和一个 dockerfile context（8,192 bytes），合计 40
KiB；它们在执行结束报告中全部仍在。BuildKit 可在后续构建中更新或替换 mutable
context，因此该观察不证明精确 prune 越界；也没有逐事件跟踪来断言是哪次后续 build 替换了它们。执行终点“无组外删除”结论与较晚快照“3 个 mutable
context 已变化”应分别保留。

## FeatureBench 阶段 2b 已完成部分预验收（09:08:56Z 索引）

结论：**官方校准 15/15 PASS；已完成 11 题 overlay/UID 子项 PASS；12 题 prepared metadata/runtime
provenance
PASS。整个 FeatureBench 阶段仍 pending**，不提前冻结或进入模型验收。验收方仅重读已有报告、固定 parser 和当前关联，不重跑官方评分、UID 容器或模型；模型调用为 0 的本阶段边界保持。

本次索引为 `runs/calibration/featurebench/current-selection-index.json`，updatedAt
2026-09-09T09:08:56Z，SHA
`4b0d98a51a7c079fb300a533494ccc304d2ed5e6373e8feae7889c4cce94b729`；其 task ID 集合及 manifest
SHA 与已接受 selection `62c8644a…b44185`
完全匹配，仍 15 题/14 仓。索引同时保留 Setuptools、Deprecated
Fields、Pipeline 三份退休失败及独立报告 hash。该 current 索引是进度快照，后续准备可更新，不把它本身作为不可变冻结完成证据。

**15 题官方 baseline/gold
PASS**：逐题重新调用固定上游 parse_test_outputs 和 build_test_status 解析现有原始日志，30 组结果与各自 official-report.json 的测试明细完全一致。每次使用锁定源码 gitCommit
`8d4e347ec575…`、数据 revision
`76b4a4566e04…`、对应官方 manifest/config/imageId；prediction 文件 SHA 与 score 记录相同。所有原指定 P2P 文件集合均实际存在并执行，baseline 的官方 f2p_success 均 false、p2p_success 均 true；gold 两者均 true。30 次 patch_applied=true、error=null，score 完整且容器 cleanup=removed。Hatch、新 Sympy
inverse 均以自己的新官方报告通过，没有继承退休题的结果。

**11 题当前 overlay/UID PASS**：Packaging、MLflow、Meson、Metaflow、Pandas、Sympy
Puiseux、Xarray、Hatch、Pytest、Astropy、Seaborn 的 22 次当前 overlay 评分同样经过独立原日志重算，preparedImage/baselineCommit 均与当前 runtime/prepared 对应，22 个 scorer 容器均 removed。除下述 MLflow 的已识别日志前缀外，官方与 overlay 的 baseline/gold
test ID→status 映射完全相同；MLflow 做只用于验收比较的精确前缀去除后也完全相同。

11 份 agent-environment 报告共
**68 个真实检查**，全部 passed/returnCode=0；真实 launcher 初始化后各任务探测为 UID
10001，identity 的 NNP、原测试读取、canonical target
import、pytest、workspace/私有依赖边界及 tracked worktree 检查均已有记录。agent
report 的当前 image/preparedSha256 与公共验证函数相符，cleanup 全部 removed。此处依赖此前已审查的 UID 探测实现与本次逐报告证据，不把评分阶段 root 身份误当作模型运行身份。

**12 题当前准备关联 PASS（metadata/provenance 范围）**：以上 11 题加 sklearn，均 ready/flattened、hiddenTestsRemoved、单一基线 commit、prepare
cleanup removed。packageIsolation
auditVersion 为 v3/v4，Pandas 为已独立实测通过的 v4；除已核对的 hypothesis 集成外没有 skipped 同名副本。runtime.preparedSha256/taskBaseCommit 与当前 prepared 对应，公共 validate_runtime_provenance 全部通过，相同当前 core 与冻结 runtime 脚本关联未变化。本预验收不新增“12 个镜像所有内容已逐字节全审”的声明，也不代替剩余题最终实际环境核验。

**原始解析边界（不改官方报告）**：MLflow 日志把 MEM/DISK 瞬时数值前缀带入 test
ID，因此原官方和 overlay 的字符串键不完全相同。验收比较只去掉 `| MEM … | DISK … GB `
这一固定观测前缀；baseline/gold 的 F2P/P2P 全部映射一致，没有归一化键碰撞，状态数量也完全相同。不得声称原始字符串逐字相同；本操作没有回写日志、parser、评分结果或测试内容。

Pytest 的固定 parser 将 pytester 内部预期失败 `test_unicode_plus_minus.py::test_foo`
计入 P2P 明细，因此官方与 overlay 均显示 106 success/1 failure。但该失败输出位于外层
`TestApprox::test_unicode_plus_minus` 执行的子测试中；原 approx.py 最终 **90
passed**，5 个外层 P2P 命令全部 exit 0，baseline/gold/overlay 前后相同。官方运行器依照这些命令 exit
code 判 P2P 成功。这不是与两道退休 Pydantic 题相同的外层 P2P 失败，也不应把此明细数直接当作顶层失败数；保留上游原明细并说明限制，不私自修官方 parser 或放宽判定。

该快照中 Sympy
inverse、Matplotlib、Sphinx 的准备/runtime 仍未完成，sklearn 的 overlay/UID 仍 pending；后续可变的准备文件 hash 或尚不存在的 pending 路径不被本预验收算成通过，也不当成已交付失败。待新索引和尾项证据全部落盘后，再检查所有当前 hash、镜像、评分/UID、清理及冻结关联，给整个 FeatureBench 阶段最终结论。

## Matplotlib：隐藏 F2P 的 Meson 引用修复预验收

结论：**PASS（代码、回归及新 prepared 归档范围）；runtime/parity/UID 仍 pending**。本项须在后续真实运行证据完成后才整体关闭。验收方没有修复实现或重跑准备/评分；仅只读比对归档并执行已交付的一个隔离回归测试。

主审计 `runs/audits/featurebench-matplotlib-meson-repair/audit.json` 本轮 SHA 为
`f681ef47756de4258f56ea2320ba3ccc22c946b0a885285be9549d4962a35435`，关联当前新 prepared SHA
`6883f56dcff4e9b341309ccade7517557ae76bbe35b678041468c6a2c69419ea`，ready=true，image
`42afdf836b3bdeddf9e37c1a2b588938ddb981a43d1e192f6ae009b46399b93a`，基线 commit
`859e19143ed3429253535cfe976420b1d88e8148`；准备容器已 removed。

**变更范围 PASS**：验收方独立流式重算两份 176,486,400-byte workspace.tar，旧归档 SHA
`a0b73ee80ab7b98818cb82ef4e5fdc616c8401d8547313a153931866824c85e2`，新归档 SHA
`5b08c02bc4947f28ae75fe73130202f5ca2771a4e8495234f594d12e61948482`，均与审计匹配。排除 `.git`
后各 6,417 条 tar entry，无重复名字；逐条比较 type、mode、size、link target 和文件 SHA，**只有
`lib/matplotlib/tests/meson.build` 改变**，其余 6,416 条完全相同。独立生成的 unified
diff 与审计及 meson.diff 字节相同：仅删除 `'test_backend_registry.py',` 这一独立条目。

Meson 文件前后 SHA 为 `be10d56aae19cd036eab3c5b346fe7c790c263be6dfd8f7dba0d21c78bfa5694` →
`05fe387cceb5776693827ba946ea14c4a9416e9f02bd42b464aa19a74c77d053`，与新 prepared
buildManifestSanitization 相符。已隐藏 F2P `lib/matplotlib/tests/test_backend_registry.py`
在旧/新归档均不存在；五个原始 P2P 文件各自的内容 SHA、type、mode、size 均与旧归档及审计记录完全相同。没有恢复隐藏测试或修改其余实现源码来绕过初始化问题。

**适配与回归 PASS**：`sanitize_missing_test_build_entries` 只接受 workspace 内已不存在的 hidden
path，读取同目录 meson.build，匹配独立的带引号 basename/逗号行并删除；不创建缺失文件，不执行 Meson，不改注释中的名称，也不移除仍存在的测试。prepare 在官方初始化和源码副本隔离后确认 F2P 已不存在，再调用该 helper，最后生成新的单 commit/flattened 基线，因此 source 可导入所需的构建列表与当前实际文件一致。评分是否仍完全等价，需要等待本题新 runtime 的官方 baseline/gold 和真实 UID 导入。

交付回归 `MissingTestBuildManifestTests` 已单独运行 **1
PASS**，覆盖移除唯一列表项、可见文件内容保持、hidden 文件仍不存在、同名注释保持、重复调用不再改动，以及拒绝清理仍存在的文件；本轮不新增测试或修改实现。

**非阻塞计数说明**：初始 audit 的 visibleTestEntryCount=2456 未写筛选定义。本次按“归档路径含
`/tests/`”独立统计为 2,518 条，其中 64 个目录、2,454 个普通文件；排除唯一改动 manifest 后 2,453 个文件完全不变。不将这类条目数说成实际测试 case 数，亦不以未定义的 2456 口径替代上面的完整 6,417 条比较。已反馈实施方补定义或改为可复算口径；完整变化集合与五份 P2P 的结论不依赖这个数字。

### Matplotlib 新 overlay parity 增量复验

结论：**PASS（当前 runtime provenance 与官方 parity），UID 仍 pending**。新 runtime 为
`3895da9bcc5d47f2a0ea9a053ed90d75c6feea19242a24db58ddf29e351e75a4`，runtime.json SHA
`513f4350c41d2a638fa81e1ff921e01c9377d23b23f9edb81fee5c230c656c8b`，精确关联上节 prepared
SHA/基线 commit，公共 validate_runtime_provenance 通过。

`overlays/20260909-matplotlib-meson-01-3895da9bcc5d/calibration.json` SHA 为
`0f982a1451cc30c6094f131051b0618ba9e7f1f17f161d8a4478967b1499f136`。验收方用固定 parser 重算原始日志：baseline
F2P 6 success/23 failure、P2P 29 success/ 0 failure；gold F2P 29 success/0 failure、P2P 29 success/0
failure。两模式的完整 test ID→status 映射与原官方报告完全相同，五份原 P2P 输出齐全。baseline
92.722 秒、gold
90.229 秒，evaluation 与预期一致且 error=null，两个 scorer 容器已 removed。没有用降低测试范围来取得 parity；仍需真实 UID 导入/工具与清理报告后关闭该修复。

## 公共冻结：benchmark 源码/数据/评分锁关联补充

结论：**PASS（代码及定向漂移回归），must-fix 无**。实际 30 题 suite 尚未 freeze，本项不构成冻结完成或模型运行通过，也没有旧冻结锁需要迁移。

`freeze_suite` 根据所选 task 的 benchmark 集合，将对应 `experiments/featurebench-lock.json` /
`experiments/cooperbench-lock.json` 的完整文件 SHA 存入 benchmarkLockHashes。`require_freeze`
在运行前检查该字段存在并逐文件匹配，调用位置早于 doctor、批次分配和 session 创建；run/resume 都经过此入口。新批次同时保存 suite-lock.json 及 benchmark-locks/ 下的原始锁副本，便于复查实际 source/data/evaluator 依赖身份。没有改变已有逐题镜像、准备、评分及 UID
hash 门禁，缺少新字段的旧格式锁会明确拒绝。

新增 `test_frozen_suite_rejects_evaluator_lock_drift_before_execution`
先证明固定锁可通过，再只改变 evaluator source
gitCommit 并确认 require_freeze 拒绝。验收方使用 RUNBOOK 指定的外部 adapter-venv 执行该定向测试通过；默认宿主 Python 未安装 pytest 的首次命令没有运行测试，不算失败回归证据。全套公共测试由实施方另行完成，本次不重复 loopback
HTTP 或其他已验收范围。审查时 cli.py SHA 为
`5e745806f7ee4874e6ac8baba9c7a6f30583d5064ee2ccfdcb099638286a601e`。

## 退选 Pydantic 官方镜像容量处置：独立范围验收

结论：**PASS（仅精确单镜像回收范围），must-fix 无**。验收方没有删除资源。允许范围为
`sha256:5350dd2807bfaea8307fc11865334df43c71f176bc2c1ef11b83880fe0a5cbf5`
及执行时仍解析到该 ID 的已核验官方/pin 别名，使用
`docker image rm --no-prune`，无 force、无通用 prune，保留 OCI 压缩材料、当前镜像、历史失败与退选题元数据。

提案 `runs/audits/capacity-matplotlib-pydantic-sklearn-20260909T093631Z/pydantic-candidate.json` SHA
`62408bf500c3565062ae227274b678692b8a1494744fac9255575ff8ee9c0b59`；恢复报告 SHA
`611a30c83f28e0cfc5a420ffaad24f86de3f5f40646ecfe4945ca5e2ea35f904`。验收方独立读取并重算
**全部 21 份** manifest/config/19 compressed layers 的 SHA 与 size，均通过；层合计 10,978,895,720
B，连同 manifest/config 共 10,978,908,206 B。manifest 的 config/layer
digest 与 size 序列完全对应这些文件，config 的 19 个 RootFS
diff-ID 与实际已加载镜像完全相同。这里只核验可恢复材料，未实际 reload。

只读 live 检查覆盖 122 个 image、全部容器和 61 份当前 prepared/runtime/core 文件：其他 image 对原 Pydantic
RootFS 第 8 索引之后排除标准空层的 10 个任务层引用为 0，候选镜像的 container/current-metadata 引用为 0，当前 15 选题无 Pydantic。早期共享基础层不在提案中。退选 deprecated-fields 与 pipeline 的失败证据仍属保留项。

`/tmp/evict-retired-pydantic-image.py`
在执行前固定提案 SHA、拒绝覆盖旧执行审计，复查选题、当前 metadata、容器与标签归属；逐个别名重新 inspect 确认仍是精确 ID，记录删除返回码，执行后核对 image 差集及全部保护文件 SHA。没有压缩材料或缓存删除路径。Docker 独占 31,566,275,266
B（29.398 GiB）是回收估计；53.928→83.326 GiB 为理论容量，实际释放及 Sklearn 76.4
GiB 门槛是否满足均须在执行后测量，不能据此宣称容量或最终准备已经完成。

### Pydantic 精确单镜像回收执行后复验

结论：**PASS（执行结果），must-fix 无**。执行审计
`runs/audits/retired-pydantic-official-image-eviction-06.json` SHA 为
`ae7593d7eba44b23e490d428fb5f43820e5eb6553893445684e4adec4d26feae`，status=completed。唯一 action 是原官方 tag 的
`--no-prune`
删除，returnCode=0；独立重算前后 image 集合，122→121，仅候选 ID 消失，没有新增或组外删除。后续 live 只读检查仍确认候选不存在、其他原 121 个 image
ID 全部存在。

执行终点 changedProtectedMetadata=[]，保护 61 个 metadata 文件。验收时 60 份仍原 SHA，Sklearn
prepared.json 已因获准启动新 generation 而变化；其原 SHA
`8f5c85ecd0dfd5281e3493aff64f2b1fbb870e79a185edec799c73b701f1067f` 的完整文件在
`runs/preparation-history/scikit-learn__scikit-learn.5741bac9.test_public_functions.28421aef.lv1/20260909T094745Z-54ff3c849424/prepared.json`
中原样保留，当前状态为 ready=false/stage=flattening_sanitized_image。因此不将合法后续准备误报为回收造成的 metadata 修改，也不声称后续 live
61 份始终未变。全部 21 份恢复文件仍存在且 size 不变，恢复报告 SHA 不变；本轮不重复读取 10 GiB。

free 57,896,079,360→89,462,456,320 B，净增 31,566,376,960 B（29.39848 GiB），终点 83.3184
GiB，已超过此前 Sklearn 76.4
GiB 启动门槛。这里报告实测空间净差，不保证后续准备期间空间保持该值，也不据此通过最终准备或模型阶段。

## Sklearn Meson copy 适配：代码与临时诊断预验收

结论：**PASS（代码、8 项回归与临时无模型诊断），must-fix 无；正式新 generation
prepared/初始扩展保留/导入后 mirror/parity/UID 仍 pending**。验收方只读代码与已交付证据，运行既有临时文件回归；未修复代码、启动诊断容器或重跑官方评分。审查时 featurebench.py
SHA 为 `521a1cb817fadd7062180c467bcd67f4f2ef79159804387e9ef18614a067e48c`。

`materialize_meson_copy_outputs` 只解析 build.ninja 中明确的 Meson `--internal copy`
整行规则，不执行 Ninja 命令；跳过带变量或不支持的规则。source 必须为 canonical 包内
`.py`，destination 必须位于 workspace/build 内且当前为精确指向该 source 的 symlink。仅将这种输出改为当前 masked
source 的普通副本，记录 source/destination/
manifest 和内容 SHA，并立即检查字节 SHA。其他 symlink、编译扩展与非匹配路径不改。prepare 在官方 mask、包副本隔离及隐藏测试清理之后执行物化，再生成 Git 单 commit 和 flattened
archive；实际 agent launcher 随后按 UID
10001 接管整个 workspace，因此正式路径中的物化先于 launcher，不复用“launcher 后 root 新建文件”的临时顺序。

`verify_target_module_location` 接受 canonical 内模块，或逐条被 prepared 审计登记的精确 build
destination；每次都检查全部登记 source 仍等于准备时 SHA、mirror 字节等于 source。即使模块本身来自 canonical，也不会跳过映射完整性检查。未知 mirror、mirror 单独改变、source/mirror 同步改变但偏离准备 SHA 均会拒绝。target
probe 以 UID 10001 使用原 `/opt/miniconda3/envs/testbed/bin/python -B`
实际 import 后执行这些检查；没有以 runtime 私有解释器替代原任务解释器完成 import。新增 `.so`
前后 hash 采集如实记录 editable
rebuild 的增删改，不把重新编译后字节改变误称初始保留失败；初始保留仍必须独立比较准备归档，不能仅凭前后计数通过。

验收方执行 `tools.benchmark.tests.test_featurebench`：**8/8 PASS**，其中新增两个 Meson
copy 测试实际复现 SameFileError、证明只物化登记输出且保留其他链接/二进制、允许正常 source 编辑再 copy，以及拒绝未知/陈旧/共同偏离原 SHA 的 mirror。其余六项隔离、Meson
hidden
entry 和跨新旧准备锁恢复回归也通过。四个已冻结 runtime 文件 environment/launcher/configure/artifacts 的 SHA 与既有 core 代际完全不变。

临时主证据 `runs/audits/featurebench-sklearn-copy-pilot-59f90ff1/audit.json` SHA
`70bf9e666aa1d964281e29c215083e842139d66bec9771c5eade76beb1e9e126`，使用旧 runtime
`43128f25ea14c796be28617651b3557a48d34814d632b600de8dd3cc7bfe9357`。先以 UID
10001 复现明确 SameFileError，再同 UID 物化 6 个已登记 copy 输出；随后 UID import
returnCode=0、97.3195 秒，Ninja 完整执行至 252/252，最终 `__file__` 为
`/testbed/sklearn/__init__.py`；随后 root import
0.8873 秒且 returnCode=0。验收方独立读取保存于 20260909T094745Z-54ff3c849424 的旧 workspace.tar：六条映射的 manifest
copy 规则、source SHA 与 destination 原 symlink 全部吻合，原归档包含 69 个
`.so`。这个旧归档计数不能替代新 prepared 的 69 扩展字节保留证明。

原始 import 失败审计 `featurebench-sklearn-uid-15e4c0a3` SHA
`1d40141cd53d9b28dba3f92abac85bc61f77a0d020ad45b50ee261ffc1b66db4`，以及先 root 物化后 UID 仍失败的
`featurebench-sklearn-copy-pilot-90756488` SHA
`39c5fd0fc0c2bb33ef6736fdac877cd278dcbfe3f2e4a91510f5f4252fd2949b`
均保留。后者的原日志明确显示 UID 的两个 copy 子命令失败、随后 root 导入成功；权限原因属于操作顺序及代码支持的诊断推断，日志没有直接打印 PermissionError，不能虚构该文本。三份审计均 modelCalls=0、cleanup=removed，live 只读 container
ID 检查确认三者均已不存在。临时诊断不包含正式新 generation 的 import 后 mirror/扩展 hash 和官方 baseline/gold，因此尚不能关闭 Sklearn 或 Feature 全 15 题阶段。

### Matplotlib 可见测试条目计数说明复验

结论：**PASS，前述非阻塞计数说明已解决**。更新 audit SHA 为
`9d069d32c200a3712a356b07c88b7b7756d1be60673dea73c45e9073485b3de6`，原 audit SHA
`f681ef47756de4258f56ea2320ba3ccc22c946b0a885285be9549d4962a35435` 在 history/
1788945980485713908-audit.json 原样保留。新筛选定义为非目录、非 .git、路径包含 `/tests/`
或 basename 以 `test_`
开头，并排除单独审计的 tests/meson.build。验收方按该定义重新读两份 tar，**精确 2,456 条名字**与 visibleTestEntryNames 完全一致，所有 entry 的 type、mode、文件 SHA 或 link
target 前后相同。这里是归档 entry 数，不是执行 test-case 数；此前完整唯一改动和五份 P2P 字节结论不变。

### Sklearn 新 prepared 归档与源码边界增量复验

结论：**PASS（新 prepared 与初始源码/编译扩展边界），must-fix 无；当前新 runtime、官方 parity、真实 UID 导入及导入后 mirror/扩展报告仍 pending**。本次未运行模型、重新 prepare 或评分，只读归档与 Docker
image/container 身份。

主审计 `runs/audits/featurebench-sklearn-meson-copy-repair/audit.json` SHA
`5df1bc9689da3f950aa376e4eb63d13593f6df2442a7124eb51f915143dc63dc`，精确关联新prepared.json SHA
`7b94aee173ed15fa061cf8d753de980c3106bde89ef35b1196bc62629ebca717`，ready=true，generation=382c777cd9764d22a3dc33acff858ce4，baseline
commit `10183bf782e109cf9bed268eb5356940fb14a31a`，prepared image
`ee368218b6caa71e7e2c91aa04e08cd69da2b248b63ee469bd6ebf4c4e8d697d`。live inspect 该精确 image
ID 存在且 RootFS 只有一层；准备容器 bc9e14e40f5991c3de7f71e929c40090f6314abaf2bbdf64b2891bb705b3693c 已不存在，与 cleanup=removed 一致。原 prompt 文件逐字节等于固定 fast 数据行，SHA 与 manifest/
prepared 相同，source/dataset revision 仍与锁匹配。

验收方完整重算旧 tar（137,011,200 B）SHA
`15c4d03ad982c87317e2eef6bbae5a54c71427796ec1b27de21f2ac86f90abb3`，新 tar（137,031,680 B）SHA
`fd953ecf5b0d9d370405a4199ea32000cefccc8823673f1db084516527c6ef18`，均与报告匹配。排除 .git 后各 2,393 个 entry，名字集合相同且无重复；逐 entry 比较 type、mode、size、link
target 和文件 SHA，**仅已登记的 6 个 build/cp310/sklearn
copy 输出改变，其余 2,387 个 entry 完全相同**。

六处旧 entry 均为精确指向对应 `/testbed/sklearn/.../__init__.py`
的 symlink，新 entry 均为普通文件；每个新副本的内容 SHA、mode、size 与当前 canonical
source 相同，source 本身前后完全未变。六个 source/destination
SHA 与 prepared 及审计映射完全一致；新 build.ninja 中每条精确 `--internal copy`
规则仍唯一存在，manifest 本身没有变化。没有恢复被 mask 移除的实现，也没有用未知包副本替代 canonical。

**69 个 `.so`
初始保留 PASS**：旧/新归档中所有 build/cp310/sklearn 扩展的路径集合、type、mode、size 和内容 SHA 完全相同，69 个逐路径 SHA 也与 compiledExtensions.files 逐项相等。这是导入重建前的实际归档比较，后续 editable
import 可以产生正常编译输出，届时须按单独的 rebuild 报告解释，不能混称初始归档发生变化。

按 audit 的非目录且路径含 `/tests/` 或 basename 以 `test_`
开头定义独立筛选，精确 388 个条目名字与 visibleTestEntryNames 一致，全部字节/类型/模式不变；五个P2P 文件的路径集合与固定原数据完全相同，各内容 SHA/类型/模式/size 前后保持。唯一原 F2P
`sklearn/tests/test_public_functions.py`
在两份归档均不存在。新 .git/HEAD 指向的 refs/heads/main 等于记录 baseline，config 无 remote；这不替代后续 runtime 关联与实际评分。当前 selection
SHA 仍为 62c8644...，尚未把状态字段迁移或全套环境冻结当作已完成。

## 阶段 2b 终验：FeatureBench 全 15 题与合计 30 题环境

结论：**PASS（FeatureBench 15/15；CooperBench
15/15；合计 30/30 环境准备），must-fix 无**。本结论关闭此前本阶段的 pending 环境项及 F1、Matplotlib、Sklearn 修复项，范围为固定选题、官方 baseline/reference、当前 prepared/runtime、实际 agent 用户环境与证据清理。**suite 尚未 freeze，模型调用为 0；两题真实 parent/child 试跑、30 题模型单轮及最终新会话运行验收均未完成**，不得将这些后续阶段记作 PASS。本轮验收只读证据、重新解析已有日志、检查镜像/容器/进程身份及执行状态/help 入口；没有修复实现、重跑官方测试、启动模型或调用 freeze。

### 最终清单、锁和范围

Feature 最终 manifest SHA 为
`ddd1afd400a6ae2fb1eb772ffbf2913542569dd19a0928d66a720a97e79035d1`；Feature lock SHA
`537f44995eb84c41a9e5aa951a6fca581955a97660be7939d009e11585d86059`。仍为 15 个 fast/Level
1 独立任务、14 个仓库；原 prompt、source/environment
pins、分工与选题身份不变。验收方独立递归比较 transition 的 before/after
manifest：**精确 16 个值变化**，只有 selectionStatus 和各题 calibrationStatus，与交付字段 diff 完全一致。当前两文件逐字节 SHA 等于 after 快照。lock 仅变化 selectionSha256、calibration.status，并新增 runtimeParityPassedTasks=15 和 agentEnvironmentPassedTasks=15；source/data/ 其他已有材料锁未改。transition
SHA `906e5626ef260385f43f243da1543d9a46e1dfb3ed9b3174ad998b311b8f39bb`。

最终 current-selection-index updatedAt=2026-09-09T10:08:14Z，SHA
`4584487c372d5a8874bc5446438c64018fbb370643620710e2b5996119f5761f`，绑定上述 manifest，五项计数均 15。验收方逐一重算
**75 个引用报告 SHA**（每题官方/prepared/runtime/ overlay/agent），全部匹配；task
ID 集合与当前 manifest 完全相同。三份退选题原 baseline
P2P 失败报告 SHA 与之前接受的证据相同，仍为 failed；没有用模型成绩换题。current 索引仍是汇总快照，后续冻结应保存其引用的不可变报告，不把可变索引当作已经冻结的实验结果。

generic-mask-impact SHA `73af1ad01e0b2ec811eda4170f6c979e4a3ad7d71a6d17b131e3336786dac57f`
同样关联最终 manifest，当前 15 题与 retired 3 题齐全；每题 prepared SHA、auditVersion、skipped/
matched 明细与当前 prepared 相同。根 generic mask 仍只有 Pandas/Xarray：Pandas 为已完成 v4
original-hash 匹配，Xarray 没有 skipped
source 候选，之前限定 F1 重做 Pandas 的范围成立。历史 selectionChanges 的原状态保持为当时事件，不替代上述当前实际验收结论。

### Feature 官方评分与当前环境

固定上游 parser 独立重算 **60 组已有日志**（15 题 × 官方/当前 overlay × baseline/
gold），全部与对应 official-report.json 的完整 success/failure 明细一致。每组 prediction 文件 SHA、source/dataset
revision、实际 P2P 输出文件集合均匹配固定数据与 score；没有重新运行评分。所有 baseline 均 patch_applied=true、F2P=false、P2P=true、error=null，所有 gold 均 patch_applied=true、F2P/P2P=true、error=null。原指定 P2P 文件集合是 Meson
4 份、其余各 5 份，均完整执行；不把项目之间不同的原测试文件数统一假设为 5。

全部 15 题官方/overlay 的 baseline/gold test
ID→status 映射一致。MLflow 仅在验收比较时去掉此前已审的 MEM/DISK 瞬时前缀，映射无碰撞；不改原始字符串或报告。Pytest 的 106
success/1 failure 仍来自已审 pytester 内部预期失败，外层命令成功，保留该官方解析边界说明。Sklearn
raw P2P 有 790 个观察项，其中官方归类 success 788、failure 0；不能把 observed count 与 success
count 不同误判为漏测。

15 个 runtime 的 preparedSha256/taskBaseCommit、core、Dockerfile/接入脚本 hash 均通过公共 provenance 检查，核心仍为
`20a32f60311a04e2e8a4cdba230c293b04db963eef3d4a4872c8e0ab5b334269`。15 份 prepared 均 ready/flattened、隐藏测试已移除、单 commit、清理完成；15 份实际用户报告共
**94 项检查**全部 passed/returnCode=0。除真实 launcher 初始化外，各探测均 UID10001，identity 有 NNP=1，原任务解释器实际导入 canonical 模块、可读原可见测试且可写 workspace，私有 runtime 依赖不可读，tracked
worktree 未变化。agent report 与当前 image/prepared
SHA 精确关联。只读 Docker 检查确认 15 个 prepared 与 15 个 runtime 均可 inspect，60 个 scorer、15 个 prepare、15 个 UID 证据容器 ID 全部不存在。

### 最后四题增量收口

| 任务          | 当前 runtime ID 前缀 | baseline F2P success/failure；P2P success/failure | gold 对应计数 | 实际 UID import       |
| ------------- | -------------------- | ------------------------------------------------- | ------------- | --------------------- |
| Sympy inverse | 233948f8de85         | 0/1；68/0                                         | 49/0；68/0    | 1.076 秒，canonical   |
| Matplotlib    | 3895da9bcc5d         | 6/23；29/0                                        | 29/0；29/0    | 104.767 秒，canonical |
| Sklearn       | 67e3fa06916b         | 0/1；788/0                                        | 218/0；788/0  | 101.293 秒，canonical |
| Sphinx        | 3ab36b6700c9         | 0/1；28/0                                         | 28/0；28/0    | 0.101 秒，canonical   |

Sympy inverse 与 Sphinx 新 prepared tar 全文件 SHA 分别为
`21f919a0615ea57df33f92c4a9de9d0fe02ae3f2abd867ec20f21296ca3ea21a`、
`6f69287604184eb04c8367a99fbcf48a40d2d83d0ce961e54bc9d39e708d8592`，独立重算匹配；各原 F2P 在 archive 不存在、原 P2P 都存在、HEAD 指向 prepared
baseline、无 remote。其 overlay/UID 报告 SHA 分别为 318eb853.../da00f0c1...、8b24b644.../90602220...，完整路径及 SHA 由上面的最终 index 固定。Matplotlib 当前 prepared 与 Meson 单行修复归档保持之前已审 SHA，新增 UID 报告 SHA
`ed2015d8603f0ce29878b4a4dd86eab43f9d7c8684386cafe5549d8f667b5a1b`；6 项检查全部通过并清理，连同已通过的官方 parity 关闭该修复。

Sklearn 最终 runtime 精确为
`67e3fa06916bd7885272216077734a8eeda4e8504b5565ad5123be789045101e`，runtime.json SHA
`bbb574b4db3e3a6bb8dbec085f90e2a262cb0d51fd23a9bdbd9a5c4c83be5a87`；关联此前已独立审计的新 prepared
SHA 7b94aee1...。overlay report SHA
`1157c8ff95fd966d8c2d3a7c6c7727a281e4a237df2f8aa389728c4f2f4f0c05`，baseline/gold 分别 127.953/122.792 秒，完整 test
ID/status 与官方相同。正式 UID report SHA
`0647d83df5488e8128f63e2df62b785b19863a3ee8b1f13fa789700d8c239628`，8 项全部通过。验收方核对实际记录的 target
command 使用已审 helper 的完全相同源代码及 prepared 中的 6 条映射，导入后 source SHA/mirror
bytes 检查全部执行成功，返回 canonical
`/testbed/sklearn/__init__.py`、verifiedMaterializedCopyCount=6。独立比较 before/after `.so`
的 69 个路径/SHA，全部相同，并逐项等于已审初始 tar 的 69 个 SHA；added/
removed/changed 均空。该真实新 generation 证据关闭此前临时诊断保留的 pending。

### Cooper 与公共接入链复核

Cooper 原 final-20a32f60-20260909T065404Z 主报告 SHA 仍为
`2cc87de829b327ef222258e9e1a282c4eb7db4a6b2bfa0bd39594e0bf1c4ca38`；其 15 个 overlay 与 15 个 UID 子报告
**30 个 SHA 全部未变**，15 个官方 reference 文件 SHA 也未变。每个当前 prepared/runtime 关联通过，imageId 与原 final15 完全相同，四个 frozen
runtime 脚本未变；30 个 prepared/runtime 镜像当前均可 inspect。此前已独立通过的 15 题官方 baseline/individual
gold/combined gold、90 次最终 overlay 子测试及 UID 结果仍有效，本轮不重复评分。

当前公共发现入口只使用自身 attempt_directory 的不可变校准报告且精确匹配 runtime。Go26 的最新 UID 引用是之前 C1 验证过的 agent-278daceb... 新独立报告；dirty-equals 的最新校准是之前 C2 验证过的 d9f6c5e8... 新不可变输出。两者都没有覆盖或替代历史原报告内容，当前官方/overlay/UID 验证继续通过。Cooper
lock 当前 SHA 为 `a96c16ce4b3616ee756514009434e9ac494b7acf888929f7ac98d905e93a392e`。

公共 freeze 的 benchmarkLockHashes 继续锁定两份 source/data/evaluator 锁，run/resume 在任何批次/session 动作前验证其 SHA，batch 保存 benchmark-locks/ 副本；本轮代码复核与之前漂移回归结论一致。`bench:status`
按 RUNBOOK 设置本地 Node
PATH 后真实执行，结果 selected/officialPassed/overlayPassed/prepared/runtimeBuilt/
agentEnvironmentPassed
**全部 30**，frozen=false、activeBatch=null。首次直接调用 npm 因当前 shell 未设置 PATH 而没有执行状态，按手册前置设置后成功，属于环境前置而非 CLI 缺陷。不能把此状态报告或通过的校准当作已经执行模型实验。

### worker 与运行说明收口

retired-worker-shutdown audit SHA `ccc362c26a4276212ce3eaefdeb257e63a6e3a13daf62ce5fc6254143b07ce2c`
精确记录两个原 worker 的命令、startTicks、无子进程和仅等待 retired 题的状态，SIGTERM 后退出。验收方在宿主只读确认原 birth
identity 已不存在；原 overlays-index 与 agent
index 及 before 快照逐 SHA 相同。当前 Docker 的 benchmark 标签容器集合为空，手册限定 Python
comm 的宿主 ps 查询无匹配；这不是用受限视图的缺席推断 worker 已退出。

RUNBOOK 已明确 current-selection-index 为当前选题入口、旧原队列索引可能包含退休题，列出替换/修复索引；受限 ps 视图须宿主复核，不能据 PID 缺席重复启动。CLI
help 与逐题 calibrate/prepare/overlay/verify-agent、--config/--suite、run/resume/report 路由相符。新增 benchmark-locks 冻结与批次副本说明与代码一致；已有离线分析命令保留 profile、外部 out/cache、新 generation 和手动分析不回写状态的边界。手册明确准备和校准完成后还需真实两题试跑及 30 题单轮，没有宣称模型分工或正式模型结果已通过。本项是现有运行说明的增量复核，最终模型后新会话验收仍另行进行。

## 阶段 3：冻结与真实两题试跑（进行中）

当前结论：**冻结产物与批次初始化 PASS；真实两题试跑 pending**。本节不提前通过模型执行、实际 child 分工/传输、评分、trace 或清理。试跑结束后将依据完整落盘证据分别验收这些维度；模型是否解题成功与接入实现是否正确分开判断。验收方只读检查，没有发 prompt、修改实现、启动额外容器或评分。

实际 suite 锁 `experiments/pilot-30.lock.json` SHA 为
`480cba951b605b6e8b483e1424c761c6f202f7b012314bda92be17153e54d0b9`，frozenAtMs=
1788949933565；config SHA dbe590fe...eca306b4、appendix SHA 5ef0aa13...0031a2，两份 manifest
SHA 与阶段 2b 最终版本完全相同。benchmarkLockHashes 正好包含 Feature
`537f44995eb84c41a9e5aa951a6fca581955a97660be7939d009e11585d86059` 和Cooper
`a96c16ce4b3616ee756514009434e9ac494b7acf888929f7ac98d905e93a392e`，与已接受的 source/data/evaluator 版本锁逐字节一致。

验收方实际调用只读 `require_freeze` 通过：30 个唯一 task
ID，Feature/Cooper 各15，逐题 prepared/runtime/agent/official/overlay **150 个证据文件 SHA**
全部匹配。每题 runtimeImageId 对应当前镜像 metadata，provenance、agent
identity 与 overlay 精确镜像关联通过；Feature 75 个引用等于阶段 2b 最终索引，Cooper
image 等于原 final15，校准引用均指向自身不可变 attempt 目录。没有把 stage
2b 之后产生的新未知版本纳入冻结。

真实批次 `runs/pilot-pair-001/`
createdAtMs=1788949958151，晚于冻结；计划恰好 Packaging 与 dirty-equals 各一次，两个任务完整对象等于冻结 manifest 中的对象。批次 suite-lock.json 与仓库锁 SHA 完全相同，config.json 与 configSha256 一致，benchmark-locks/ 两个副本与冻结 hash 相同；15 个 adapter-source 文件逐 SHA 等于 run.json.adapterHashes，working-tree.patch 与记录 SHA 相同，保留当前未提交实现快照，便于后续复核实际版本。

首次观察时仅 attempts/001-01 已创建，phase=observing，Packaging root
session 为 ef4be59aa067b89758d8e95e5f77e362，提交记录 messageId=ad48ac0de07b1c7e2707b0aaf5bee070、status=queued；modelRequested=deepseek/deepseek-v4-flash，modelExecution/childProtocol 均仍 pending。原 prompt、固定 appendix 和 submitted 组合已由只读校验逐字节/hash 通过。这里只证明批次已按正常提交链启动；排队记录和请求配置不能单独证明模型已执行、已经生成 child 或协议成功。其余阶段证据等待两题结束后验收。

### 受控 CLI 强制退出/接续方案：只读预审

结论：**可执行（需满足下列执行门禁）；实际恢复效果 pending**。这是针对已授权真实批次中断/接续验证的有界方案，不是无干预性能测量。验收方仅阅读当前代码和方案，没有发信号、改文件、调用模型/API
mutation 或启动额外容器。审查时第一题仍 observing 且有两个 child，**不满足本方案窗口，不能现在执行**。

代码依据：`ensure_submission` 对已有 rootSessionId 且 phase=observing 的 state 不会进入 POST
create/prompt 分支，不改 createIntentAtMs、promptIntentAtMs、submission 或 deadlineAtMs；`execute_batch(..., resume=True)`
使用原 tasks/run 计划并直接跳过 phase=done 的 001-01。`ensure_control_plane` 在 runtime
image 与原 CP process.json imageId 相同、PID
birth 相同且 GET 健康检查成功时复用 CP。CP 和 collector 由 start_new_session 启动；SIGKILL 精确 Python
CLI
PID 不触发其 finally/cancel 清理，也不应杀这些独立会话。内核 flock 以实际 fd/PID 为准，陈旧 lock 文件文本不是持锁证明。

执行门禁应全部满足：002-01 已进入 observing，原提交 messageId 已确认处于 processing，只有原 parent、没有 child、没有 publication/fetch 记录，且当前没有活跃的
`oi-bench publish/list/fetch`
调用；001-01 已 done，其评分/trace/产物快照完整。精确 CLI 的 PID、birth、cmd、cwd 与本批次匹配，并确认它同时持有 coordinator 和 batch 两把内核锁；不可对 npm/shell 或进程组发信号。CP
record.imageId 必须等于 002 当前冻结 runtime，CP birth、HTTP 健康、parent native
sandbox/container 身份均正常；全部冻结文件及当前 15 个 adapter
SHA 等于原快照，不在本实验窗口改代码或重建 CP。只在第二题 parent 单独运行时重跑与 resume 相同 doctor 容量门禁，保留其实际报告及剩余 deadline/TTL，恢复耗时必须计入原预算，不延长截止时间。

额外边界：`agent_request` 仅对 HTTP
403 做有限重试，**不重试连接拒绝**。CLI 被杀会同时中止其线程内 artifact
server；resume 又先将 artifact-registry.json 置空，直到首轮 capture 才重新登记 session。故“端口已监听”不能算产物服务完全恢复。应记录 kill、锁释放、新 CLI 启动、端口监听、registry 含原 root 且 token
SHA 不变、首轮正常 capture 的各时间点；只比对 token
SHA，不记录凭据值。没有 child/传输的前后快照不是原子保证，模型仍可能在窗口中产生新 child 或工具调用；若发生，保留实际活动与失败并标注受干预，不暂停或取消模型来维持人为的“无活动”条件。

仅一次 SIGKILL 精确 CLI、确认原 CP/parent 身份不变且两锁释放后，立即使用已准备好的公共
`npm run bench:resume -- --run-id pilot-pair-001`
接续。若杀前任一门禁变化则不执行本观测；若杀后 resume 遇到锁、容量、CP/API 或端口异常，保留错误并修复相应运行条件后仍接续同 run-id，不新建 parent、attempt/repetition，不清空意图文件或延长 deadline。后续必须以全分页 API 证据核对原 prompt 只有一个、root/submission/message
IDs 与意图时间/deadline 不变，001 不被重跑，并检查可能的工具失败和观察窗口对结果的影响；仅看到 resume 命令成功不能证明无重复提交。

collector 恢复按保存 PID/birth 停止旧独立进程组后创建新的 observations
generation，旧目录保留；应记录旧末样本/新首样本及期间可能的重叠或缺口。已有 trace
generation 不覆盖；若 kill 时尚未导出 trace，最终首次导出仍可为 trace-001，不能把“必须出现第二份 trace”当作接续成功条件。导出代码会读取全部 observations 代际；最终需核对这些输入及完整 session
tree、分页与 hash 后，才能对实际恢复子项给 PASS/FAIL。

### 恢复 helper 初审及本批窗口关闭

初审 `/tmp/benchmark-live-runner-recovery.py` SHA
`6919d48fe92f291869314cfdce60adc4e5704f641b812f3e6d6e79b4d1421e1e`：默认仅 plan/guard，API 类只有 GET，Docker 仅只读 API；只有显式 --execute 进入独立审计写入和 pidfd 单 CLI 信号路径。helper 有独立 flock 和既有 kill-intent 拒绝二次中断，环境只在内存传递、审计仅存其 SHA/变量数，无 killpg/无模型 POST。before/即时 guard、CP
image/birth、两 CLI
flock、原 parent、无 child/既有 artifact 调用、实际容量与冻结 SHA 门禁齐备，monitor 同时要求监听、registry、checkpoint、collector 接管和新两锁。

**初审需补项，暂不对该 SHA 给执行 PASS**：SIGKILL 后 select.select 的退出等待返回值被忽略，尚未在 Popen
resume 前显式确认原进程退出且两内核锁释放；应拒绝尚未释放时的强行启动。实际证据还应显式比对 createIntentAtMs、完整 batch.attempts（含 taskId/repetition）和 tasks.json 与 before 快照，而非仅依赖预期代码行为或 attemptId 列表。已反馈实施方修复临时 helper，验收方不修复。实际恢复命令是原解释器直接调用仓库公共
`cli.py resume`，与 npm
wrapper 进入同一 CLI，但报告不应虚称启动了 npm 进程。最终修订 SHA/无中断 fixture 待交付复验。

主代理随后确认第二题约 135 秒时已有两个 child，**本批早期窗口错过，不执行人工中断，不放宽 guard**。当前 helper 只能继续只读/fixture 留档；不能因代码修订通过而把已关闭窗口视为重新获准执行。两题真实 pilot 不受该人工中断，受控恢复效果仍未被本批验证。第一题已完成、第二题仍运行的阶段 3 最终评分/协议验收另行进行，不能提前依据第一题模型 deadline/失败给整阶段实现结论。

### 恢复 helper 最终修订与专用批次派生版复验

结论：**原 helper 代码修订 PASS；专用恢复方案/派生代码 PASS，must-fix 无；真实受控恢复仍 pending**。本结论不重新开放原 pilot 已错过的中断窗口。验收方只读源码、fixture 与交付报告，不执行 helper、信号或新模型批次。

原 helper 最终 SHA `46ddcec61a6ee4bca10464f882a5ab3a85fb522d0fc221d4fcb49e9e07190d3c`，fixture SHA
`23904d420f3df33df643648336d565309f5bafd8b6462ff738dc35a8440dc8c6`，解决两项反馈：SIGKILL 后实际要求 pidfd
readable、原 birth 已不存活、两把内核 flock 均空，original-runner-exit.json 保存检查；任一失败不会 Popen
resume，记录 failed_after_kill 并保留 CP/沙箱。monitor 逐轮检查 createIntentAtMs，并在 after.checks 显式核对 create/prompt 意图时间、deadline、完整 batch.attempts 对象和 tasks.json 的原始 SHA/ 内容。已读 10 项 mock
fixture：新增三种退出/锁门禁失败均断言不启动 resume，其余覆盖默认只读、guard 未就绪、pidfd 已退出、唯一 pidfd 信号、环境只在内存传递、启动失败不重试等。实施方报告系统
`/usr/bin/python3` 下 10 PASS、Ruff/compile 通过；验收方不将这类 mock 成功写成真实进程恢复成功。

专用版 `/tmp/benchmark-dedicated-runner-recovery.py` SHA
`150cb2819596c34a69a3dcf0ac93e539a156bf5dd61ccf2c8e54a90928804c7a`，fixture SHA
`6ac282b21c9e08d6187d9049cc043708297c806e53c01b4ab722f500ce4fab42`。独立重算上述四个文件 SHA 与 derivation.json 一致；按原版/派生版实际文本生成 unified
diff，与交付 `/tmp/benchmark-dedicated-runner-recovery.diff` 逐字节相同，diff SHA 为
`8302dce36e907b4697c8656d68c3b8d8561b2911853254e58baf94acd2782e3c`。

增量范围为唯一新技术验证批次 **recovery-dirty-001 /
001-01**：batch.attempts 必须精确等于 dirty-equals-43-2-3、repetition=1 的单条计划，tasks.json 只能含该题；原 prompt 的 processing/唯一 message 与 POST 门禁保持，父 session
POST 数改为恰好 1。动态 guard 仍要求当前无 child、没有 spawn 请求/任何 artifact 调用或发布/ 传输、原 parent 已注册、真实模型工具事件已出现、资源与冻结 SHA 合格。不会通过绕过原窗口条件来做这个专用实验。

跨批次前置条件要求 pilot-pair-001 整批 complete，001-01 和 002-01 的身份与原计划一致且 done、cleanup
complete、trace complete/exported、最新 scoring completion
SHA 匹配；原 CP 已退出。没有要求原模型解题成功，因此不会选择性排除第一题自然 deadline/未解题结果。before 哈希覆盖**整个原 pilot 目录**，恢复后比较所有路径、文件 SHA 和 size 及完成记录；新旧 batch 不复用 attempts/CP 目录。旧 pilot 在这段 before/after 窗口须保持静止，报告重算等合法写入应在开始前完成，否则完整性检查会如实拒绝。

原单 CLI pidfd、两次 live
guard、一次 kill-intent、退出/锁释放确认、CP/parent 身份保持、监听+registry+首轮 capture+collector+两新锁的恢复门禁没有放宽，失败仍不碰 CP/沙箱或新 runner。default 不预建目标 run 或 audit；本次只读检查时 recovery-dirty-001 尚不存在。新增 8 项 fixture 检查跨批次未完成、两题 trace/
cleanup、scoring
SHA、旧 CP 未退出、错误/多题/第二 repetition、默认不建目录等拒绝条件，明确保留原模型失败。实施方报告共 18 项 mock
PASS、默认真实 guard 因新批次不存在而拒绝；这些只证明门禁实现和待机，不构成实际中断已执行。

可以在公共入口新建此专用批次、所有动态 guard 实际满足后，由主代理执行一次受控恢复验证；若再次错过窗口则仍不放宽。该技术批次不替代原两题或后续30题，不合并其分母、不取 best
attempt，报告必须保持受控干预标记。若开始前公共 reporting 等 adapter 完成授权修订，新批次应捕获修订后的 adapterHashes/快照，helper 将当前文件与**新批次**相比较；不要求新批次倒退为原 pilot 代码，也不能修改原 pilot 保存的历史源码、配置或原始运行证据。实际恢复和最终模型/评分/
trace/清理结果仍待独立终验。

### 专用 recovery-dirty-001：真实即时恢复独立验收

结论：**PASS（真实 observing 状态中断/接续、无重复提交和即时服务恢复），must-fix 无；专用批次最终模型/评分/trace/清理仍 pending**。本次验收只读已有审计、原始 HTTP 日志、文件 SHA 与宿主进程/容器状态，没有发送 prompt、信号、修改代码或启动额外评分。该单题技术批次不加入原两题 pilot 或正式30题的分母，不替代它们的模型结果，保持受控干预标记；没有把这次 observing 恢复夸大为实际覆盖了未知 POST 响应丢失竞态。

审计目录：
`runs/audits/live-runner-recovery-recovery-dirty-001-1788953877483-83507069/`。执行时归档 helper-source.py
SHA 精确等于已审专用版
`150cb2819596c34a69a3dcf0ac93e539a156bf5dd61ccf2c8e54a90928804c7a`。result.json SHA
`6e7ed072061bf7cc3163824285a48209e2454871f42513ee6cfe86122cd6f1f5`，status=restored；after.json SHA
`5effbc58de20808821a541f5f9347756423524ad690e10da1d744ae26bfea1d2`。14 个 after.checks 均 true，验收方未仅依赖这些布尔值，而是重新比较其底层快照及当前可重复读取的证据。

**精确信号与接管 PASS**：before/即时 guard 与 kill-intent 指向同一 Python CLI PID 751263、birth
3670838，独占 coordinator/batch 两把确切 inode 的 flock；记录机制为 pidfd_send_signal/SIGKILL，非进程组。killedAtMs=1788953877650；original-runner-exit.json 于 1788953877703 记录 pidfdReadable=true、原 birth 不再 alive、remainingKernelLocks=[]，晚于 kill 且早于新 runner
startedAtMs=1788953877709。新进程 PID 754583、birth 3675308 使用原解释器调用相同公共 cli.py
resume、原 run-id/config。live 只读确认原 CLI 与旧 collector birth 已消失，新 CLI 和新 collector
PID754660/birth3675346 仍正常，内核两把锁均属于新 CLI。

原 CP PID751337/birth3670884 仍为同一进程；原 parent container
55a4f46c8f87d570e0c6c6acb94ca0babde4f9dd34a3265344a2ca8757bb1c3e 的 image、StartedAt、host
PID753898、session/native sandbox labels 与 token
SHA 前后完全相同，当前仍 running。验收只比较凭据 SHA，不读取或输出 token 值。说明本次确实保留了原 CP/ 模型 sandbox，没有用新 parent 或新容器代替原上下文。

**提交与预算保持 PASS**：root 始终为 b367f247b95d15ebd6716cc3ad98aa83，唯一原 message 始终为 391dbee673f28029d278d69f77d190f0，before/after 原内容完全相同，processing 状态一致，submission、createIntentAtMs=1788953857743、promptIntentAtMs=1788953857858、deadlineAtMs=1788955657858 全部不变。独立重读原 CP
wrangler.log，仍只有原 POST /sessions（201，request c4fd8242）和原 POST
/sessions/<root>/prompt（200，request 5695eed1），没有追加对应 POST。最新落盘 root
messages 仍只有该原 message
ID/内容。唯一标题证据、完整单题计划及 repetition=1、tasks.json 原始 SHA/内容均与 before 相同，没有另建 parent 或重试 attempt，也未重置 deadline。

**原始材料与旧批次保持 PASS**：before-files-manifest 中各副本 SHA/size 逐项通过；188 个冻结/源码相关文件 SHA 与当前文件仍相同，专用 batch 捕获的新 reporting.py
SHA
81596dc5... 是启动前修订版本，不能误认其应等于原 pilot 的旧 adapter 快照。整个 pilot-pair-001 的 313 个文件路径、SHA、size 独立重算与 before/after 两份 map 完全相同，原两题的完成状态/评分记录也相同。没有重新运行原 pilot 或修改其历史来取得恢复 PASS。

**产物服务与观察恢复 PASS（测量边界明确）**：三次恢复观察依次记录端口未监听、端口/registry 已恢复但新 capture 尚未完成、以及全部恢复条件成立；最终同时确认原 root 的 registry
token
SHA 相同、新 checkpoint 的字节/hash 经 helper 检查、lastObservedAtMs 更新、新 collector 与 observations-002 出现、旧 collector 退出、两把新锁接管，不能只根据 listener 通过下结论。即时原 parent
checkpoint 为空 patch，此时尚无代码产物；非空 patch/发布传输及最终覆盖仍须等自然执行后验收。

监听/registry 首次观察时间为1788953878236，首次观察到 capture 与全部条件恢复为 1788953878775；相对 kill 的
**1,125 ms 是采样观察到恢复的间隔**，不是精确网络不可用时长。runner 前后 lastObservedAtMs 差为2,052
ms。collector 旧 host 末样本 1788953877810、新 host 首样本1788953878124，边界差314
ms；旧 observations-001 两个文件的 SHA 当前仍匹配审计，新 observations-002 正继续追加。此边界差不是连续 CPU/所有 runtime 事件都无丢失的证明，最终 trace 必须保留两代观测并说明口径。

即时 before/after window 内 sessionTree 只有原 root，新增 child、artifact tool
event、transfers 和 publications 均为空。验收时模型已自然创建两个 child、仍在 observing；这是恢复完成后的后续活动，不把它倒填到恢复窗口，也不据此提前通过模型分工、官方正确性或清理。最终结果仍由同一公共 runner 收集并另行验收。

### 专用恢复批次最终验收：PASS（2026-09-09）

**结论**：`recovery-dirty-001/001-01`
的受控 CLI 中断、原上下文接续、真实两 child 分工、代码传输、父整合、官方评分、trace/analysis 与清理完整链路
**PASS**；无阻断正常 30 题批次的 must-fix。此结论不表示模型答对，不替代自然试跑或常规 30 题结果。验收方只读材料与确切旧进程/容器，没有发送 prompt、运行评分、实施中断或修复代码。

证据根：`runs/recovery-dirty-001` 与
`runs/audits/live-runner-recovery-recovery-dirty-001-1788953877483-83507069/`。最终 attempt SHA
`100d5dbc599fb37ed26f475ef0f93c73c3348f4a013f5e5c1d692794688d122b`，run=complete、attempt=done、modelExecution=completed、infrastructure=[]；scoring、trace、analysis、artifactCoverage、cleanup 均 complete。

**协议和人工需求审查 PASS**：机器 protocol v3 仍为 review_required、issues=[]，SHA
`4f4b48f02dc40c86d23c8f9cf5d82ea83dd08dd5eef7f921a035f13b8cbca595`。两个 child
prompt 非逐字副本；验收逐段比较原文与实际 spawn 参数，确认实质需求完整。IsMac 保留四种格式、大小写不敏感、严格 format/默认任意格式、十六进制六 octet、两种精确 repr、原模块/导出要求；IsEmail 保留普通邮箱格式、可选域、原始域精确且区分大小写、两种精确 repr、基类/相等比较及原模块/导出要求。省略背景动机、改写排版标题没有遗漏上述行为要求。模型附加的实现建议和自身测试判断不当作官方评分依据。机器原状态保留，本段记录人工语义 PASS，不改成 verbatim=true。

实际两次成功 spawn（1788954002931、1788954012357）均早于第一次等待结果；树恰为原 root 与两个直接 child，child 无进一步 spawn/task 子代理。父通过 includeResponse=true 读取两份最终回复，然后按完整 ID/SHA 成功 fetch；服务端两条 delivery 与工具调用相符。父最终回复包含两个 child 的完整 ID/SHA 和自己发布的 ID/SHA。第一 child 为 MAC（6ed271...），第二为 Email（835d18...），评分按真实 spawn 顺序绑定 feature2/feature3，没有按 sessionTree 字典顺序颠倒。

**最终非空产物 PASS**：磁盘 patch 独立重算，published、final
checkpoint、coverage、评分输入的 SHA/字节一致，每 session finalCapture=true。

| 角色        | 字节数 | SHA256                                                             |
| ----------- | -----: | ------------------------------------------------------------------ |
| MAC child   |   5161 | `c0f9746e006f25ff8dc95c7ab637907e83d8654b6736bd717f71df31979d9f87` |
| Email child |   5098 | `85a23675803472dcdd2aac20c2d857c9b8ebee66e768627c0e420b3b6b8003a0` |
| Parent      |   8701 | `78db4985e852eb0dfe45fad5d29026a5558277362ca1ea6ac8310f869914ddae` |

两次 delivery 分别 5161/5098 bytes，recipient 均为原 root
b367f247...，源 ID/hash 与上表一致。早期即时恢复的空 checkpoint 已有最终非空交付补齐。

**评分链路 PASS；模型正确性 FAIL**：score SHA
`81b0e5541ee093e03a8f99f3c07f8f8f018900e3a9e468765328368fafb27fbb` 与 completion
marker 一致；固定官方 image 8aadce92...、上游 revision
b0262a7... 以及三个准确 patch 输入分别记录。官方 child-pair 两 patch 均 applied，naive
merge=conflicts。固定上游 sandbox.py 的 lead-only
fallback 实际执行了第一 child 的两套测试，但未同时通过；最终 both_passed=false、error=null。结果中的 merged
feature 0/0 和 null
exit 是上游冲突分支保留值，不能解释成 fallback 未执行。Parent 独立 solo 评分：IsMac 78
passed；IsEmail 2 failed/58 passed，所以 parent
both_passed=false、error=null。missing_artifacts=[]；报告准确保留 child 0/1、parent
0/1、unscored=0，模型声称可见测试通过不能覆盖官方失败。

**trace、去重和唯一提交 PASS**：manifest SHA
`20caca9b3f74282e6707e4e394b3c0360b1bc0040c3439c0c1472d5b907e63b4`；hashes.json 的 26 文件逐项重算 SHA/size 全相同。三个 session 的事件为 60/23/21，共 104；各一条消息，共 3。六份 API 页均 hasMore=false，(sessionId,id) 无重复，raw/normalized
ID 集相同。本样本每 session 每类只有一页，不当成新的跨 200 条多页压力测试。单 trace/batch
analysis 均完成，后者 successfulRunCount=1、failureCount=0 是分析成功数量，不是题目正确数量。

runtime-001/002 中两条 root prompt.start 除 observed_at_ms 外整个记录完全相同：原 message
391dbee...、runtime_boot_id、容器、Docker timestamp
`2026-09-09T11:37:44.933243665Z`、event.ts=1788953864698 均一致，证明第二代 collector 重抓原日志；两代 raw 保留，不累计为第二次提交。两个 child 各一次 start。最终重读原 CP 日志，父 POST
/sessions 仍仅原 request c4fd8242，原 root prompt POST 仍仅 request 5695eed1；最终 root
API 消息仍为原唯一 message。

**模型、资源、清理与历史保持 PASS**：三 session 配置/实际 runtime
start 均为 deepseek/deepseek-v4-flash、reasoning=null，三个容器都绑定已验收 ed90a62...
runtime，每个限制 2 CPU、3
GiB。两代 host 记录有 41+1036 次资源采样，覆盖三 session；采样不证明连续 CPU 活动或精确生命周期峰值。恢复观察 1,125
ms、runner 间隔 2,052 ms、collector host 边界 314
ms 的既有口径继续保留，不宣称无干预性能样本或所有短暂事件都无缺失。

cleanup 取消/移除确切三 session 容器，remaining=[]、errors=[]；两份评分 transport 均 cleanup
returncode=0。宿主独立只读确认确切五容器不存在；原 CLI751263、CP751337、旧 collector753825、新 CLI754583、新 collector754660 的原 birth 均退出，旧 CLI
flock holders=[]。正常 30 题随后启动的新 CP/锁不算本批残留，按原身份而非公共端口判定。

再次重算原 pilot-pair-001 的全部 313 文件，路径/SHA/size 与 before
map 完全一致；188 个冻结/源码关联文件 hash 全相同。专用 run 仍仅 dirty-equals 一次 attempt，报告分母为 1。RUNBOOK 明示本批为独立恢复技术验证，不混入两自然试跑或后续 30 题分母，不用此结果替换其他 attempt；完整 30 题结果仍待其实际执行后另验收。

### 阶段4独立只读审计工具交付（2026-09-09；阶段验收仍 PENDING）

工具 `/tmp/benchmark-stage4-audit.py`，SHA
`184499d73bbf264725add2e07804bcb7a77d8105a0b9b7b485922942777a46e5`。它使用 Python 标准库，不导入适配器，不调用模型/API、评分、Docker
exec、信号、准备 worker 或写入运行证据；默认 stdout，`--output` 只允许在 `/tmp` 创建新文件。

用法：

```bash
python3 /tmp/benchmark-stage4-audit.py --run-id acceptance-30-001 --expect-planned 30 --current-source
python3 /tmp/benchmark-stage4-audit.py --run-id acceptance-30-001 --attempt 001-01 --live
```

每次保持完整计划分母；仅验收已 done 的 attempt，observing/planned 等返回 PENDING。覆盖冻结配置/清单/两 benchmark 锁与副本、adapter 快照（`--current-source`
另比当前文件）、逐题 prepared/runtime/校准/UID 报告 hash、原 prompt/附录/提交字节组成、唯一 root/message/POST 与 deadline、真实树/spawn/取回复/发布/fetch、最终产物 SHA、child-pair 和 parent 分别评分输入、Feature 官方计数/结果、trace 页去重/末页/hash、analysis 输入 fingerprint/profile/output
hashes、batch trust
anchors/全计划汇总。模型/资源限制由真实 runtime/host 记录核对；collector 重抓的完全相同 start 单独计数。
`--live`
仅查询 Docker 容器 ID 列表、原 PID/birth、确切 batch.lock 的内核 holder；不会按复用端口或另一个正常批次的锁判断旧批残留。

实际只读样本：`/tmp/stage4-audit-pilot-final.json` 255 checks、
`/tmp/stage4-audit-recovery-final.json` 172 checks 均 integrity PASS；后者包含 live。当前
`/tmp/stage4-audit-acceptance-final.json`
228 项批次/已分配元数据检查无 FAIL，30 个 attempt 仍 PENDING，工具始终
`stageAccepted=false`，不提前通过阶段4。10 项内存模拟检查验证冻结漂移、计划遗漏、child
SHA 调换、必需 hash 缺失、分析输入错配、capture 状态不符、API 重复、源码快照损坏、默认不执行外部命令/不写证据、汇总虚报成功均被正确处理；原数据未改。语法内存编译通过；环境未提供 ruff，未声称通过 ruff 检查。

人工仍须复核：两 child 的完整需求语义和实质分工、整合/验证质量、模型是否访问上游答案、评分失败的具体原因与固定上游语义、恢复干预的性能口径。缺 publication/ 协议违规与模型错误单独列为 observed
outcomes，不冒充 hash 损坏；但任何实际完整性错误会 FAIL。历史 pilot 当前源码漂移独立列出，只有显式
`--current-source`
才强制等于该批快照。退出码 0/1/2 分别表示完整性 PASS/FAIL/PENDING；0 不等于人工阶段验收或模型正确性通过。下一次在终态证据足够后独立执行阶段4验收。

### 阶段4增量异常诊断：003 Meson 观察 GET 超时（2026-09-09）

**初判：原基础设施失败保留；当前不阻断其余冻结 30 题继续。底层原因未定。** 独立只读检查
`acceptance-30-001/attempts/003-01`、该批 CP service.log/
wrangler.log、API/runner 源码及 host/runtime
observations；未重跑模型、发送取消、修复结果或热改代码。本项是异常诊断，003 的完整终态验收另由独立验收 agent 处理。

直接证据：service.log 有
`GET /sessions/f2ef5bb96f2dd3ed7504f13a5836972e/children 200 OK (30065ms)`。该 endpoint 是观察循环下一轮首先读取的 root
children；前一轮所有 children/messages
GET 均已成功，最后 lastObservedAtMs=1788958913641。30 秒后两个 root
children 请求在 router 层几乎同时完成：request
565faf61/5994a8f5、时间1788958945710/711，各 duration_ms=43/44；紧随其后是 cleanup 的 root/child
cancel。外层约30秒与 router 内几十毫秒的差异支持请求在进入 router 前/外层 HTTP 路径等待的判断，不能据此精确归因到某个代理、队列、loopback
socket 或调度器。

同期 CP 的 Sandbox/WebSocket 事件持续写入，child
prompt.complete 与内部回调在1788958921173等时间正常发生；host resource
sampling 持续，未发现该观察文件中的 OOM 事件。因此没有 CP 整体30秒冻结、模型 API 超时或容器 OOM 的支持证据。这也不证明外部 HTTP 入口始终响应正常；已有数据不足区分入口/代理/连接调度。

代码原因链明确：`common.REQUEST_TIMEOUT_SECONDS=30`，`Client.request`
对非 HTTPError 的 socket/读取超时不加上下文、也不重试 GET；runner observing 的宽异常分支保存字符串
`timed out`，标记 modelExecution=infrastructure_failure，然后进入原有 cleanup。此时 deadlineAtMs=1788960170173，尚有约20分钟余量，不是正常模型 deadline，也不是官方评分器失败。api.py/common.py/runner.py 的当前 SHA 独立比对仍等于该批 adapterHashes，没有异常期间变更源码。

异常分支没有设置 executionEndedAtMs，最终仍缺失；不能补造为正常执行结束时间。本样本结束仅可用最后成功观察1788958913641与取消日志1788958945752–5828限定观察/取消边界，不能将 elapsed 直接解释为模型完整解题时长。

本次读取时003已 done、cleanup=complete、trace=complete，原 infrastructure 数组仍为
`["timed out"]`；004已 observing 且 infrastructure=[]。建议继续原版本、原分母，把003保留为真实基础设施中断样本；不补跑覆盖、不改成 deadline/模型错误，也不据此宣布30题无基础设施故障。若同类 GET 超时复发、影响后续启动，或清理/ 导出失败，再升级诊断与阶段阻断决策。改进请求上下文/瞬态读取处理及异常结束时间需另行版本化验证，不能静默修改当前冻结样本的执行语义。

### 用户关机前暂停独立验收：PASS，可以安全关机（2026-09-09）

范围仅限 `acceptance-30-001` 本次安全暂停，不重新验收全批或启动任何工作。
`shutdown-pause-request.json`
记录主 agent 在1788961274743向已核验的 runner777675/birth3790508发送 SIGINT；验收方未发送信号。005
Pandas 在 1788961274947记录 modelExecution=interrupted、executionEndedAtMs，随后沿原 cleanup/trace/评分路径完成。最终 run.status=interrupted，005
phase=done；本轮不是模型自然完成，也不应改写成 deadline 或补跑覆盖。

005 原 root
2ee08beae7a07894013bfe8e21b54c77 与两 child 的停止后 finalCapture 均存在，artifactCoverage=complete。三份 checkpoint 均为真实空 patch（0
bytes，SHA
e3b0c442...b855），独立重算 hash/size相同，均未发布；不称为已交付非空代码。官方评分按 Empty
patch 提前拒绝，resolved=false、testEvidencePresent=false，如实保留。score SHA
`463af1716e4361a4c94e0b729b2a6fbf58a78d76b72bebe745aa7a174edd2589` 与 completion
marker、report 中005评分一致。

trace/analysis/cleanup 均 complete；trace 24 文件、analysis
14 文件逐项 SHA/size 独立验证通过。trace 保留116 events/3 messages，ID重复及parent
mismatch均为空；manifest SHA
`0abd751e945f7a0a3d78471eddec7481ccd0b99119ad87361e0f0eed8f78b698`。最终005 attempt SHA
`ccd0d7af0af36811ac36a9d32c34d6db539a0a465805e23596be675dd5db4be6`。

主 agent 关闭该批控制面后，验收方在1788961545633进行最后一次宿主只读核对：runner777675/birth3790508、collector1001769/birth4330275、CP1001402/birth4329861均不再存活；cleanup 所属三模型容器和评分容器92f7d3fe...均不存在；
`runs/coordinator.lock` 与本批 `batch.lock`
精确 inode 的内核 holders 均为空。原始 lock 文件可留作接续元数据，不等于仍持锁。

没有006提交：006目录不存在；CP
service.log 仅有001–005的五次 parent创建 POST，暂停信号之后没有新的 parent
POST。report 分母仍30，phaseCounts为5 done、25 not_started。`shutdown-pause-final.json` SHA
`24a962c20e871a7dfdc8ab8af55f1e0d7125da2841a6928a6377925df0d67fe9`，其中停止/锁/ 下一题未创建的结论与独立核对一致。

**可安全关机：本批无仍运行的模型、评分、runner、collector 或控制面工作。**
保留001–005既有结果和005用户中断标记；下次按落盘续接说明从未开始的006接续，不将005改为待重新提交。验收结束，不再启动任何任务。
