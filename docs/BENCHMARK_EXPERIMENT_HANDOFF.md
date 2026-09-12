# FeatureBench / CooperBench 实验准备交接

记录日期：2026-09-09。仓库：`/home/liuyihua/Dev/RA-Agent/background-agents`。交接时分支：`dev_opensandbox`；HEAD：`260378bec806cce25b90f2cd88f5724672e94487`。实施前重新检查工作区和分支，保留用户后续修改，不要为了匹配此记录重置代码。

## 1. 用户目标与当前进度

用户希望用本地 sandbox
backend 进行大规模 OpenInspect 实验，收集父子 session 的 trace 并分析。最终体验是：新开一个 Codex
session，要求开始实验，即可依据仓库中的配置和运行说明启动、监控或接续实验，并找到完整的 trace 与结果，无需恢复前一个会话的上下文。

用户已选定 FeatureBench 和 CooperBench，要求准备：

1. 下载两个 benchmark，**不要下载到当前仓库目录内**。
2. 两个 benchmark 各选 15 题。
3. 编写适配脚本，让任务通过 OpenInspect 正常执行。
4. 在原始任务 prompt 上追加明确请求创建独立 sandbox 中的 **child sessions**
   的短附录。仅要求 sub-agent 不会触发 OpenInspect 的 `spawn-child`。
5. 补齐批量实验、产物收集、评分、trace 导出及新会话可执行的运行说明。

任务筛选的硬要求是有实质可分工性，适合 fan-out；独立 sandbox 有实际必要性、易部署是加分项。不能仅因为任务涉及很多文件，就认定它可以有效并行分工。

**截至本文创建，只完成调研、代码检查和流程设计。没有下载 benchmark、选定题目、实现适配器或运行 benchmark 实验。**
下文的目录、命令、两 child 协议和重复次数均为拟定方案，不是已有功能或用户明确锁定的实验参数。用户本轮要求先保存交接文档；新会话收到实施指令后继续工作。

## 2. 首先阅读的本地材料

遵守根目录 [AGENTS.md](../AGENTS.md)，并优先复用以下实现：

| 文件                                                                                            | 用途                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [OpenSandbox README](../packages/opensandbox-infra/README.md)                                   | 本地启动、模型/SCM 配置、实验入口、限制               |
| [实际验证记录](OPENSANDBOX_PROGRESS.md)                                                         | 已有 smoke 实验与证据覆盖范围                         |
| [现有实验 runner](../packages/control-plane/scripts/run-opensandbox-experiment.ts)              | 正常 API 创建、提交、观察、取消与清理                 |
| [smoke 验收逻辑](../packages/opensandbox-infra/experiment-checks.mjs)                           | session 树、工具调用等检查；不是通用 benchmark 验收器 |
| [OpenSandbox provider](../packages/control-plane/src/sandbox/providers/opensandbox-provider.ts) | sandbox 镜像、生命周期、资源限制                      |
| [spawn-child 工具](../packages/sandbox-runtime/src/sandbox_runtime/tools/spawn-child.js)        | 创建 child 的授权措辞、参数与上下文行为               |
| [child 创建路由](../packages/control-plane/src/routes/session-child-spawn.ts)                   | 仓库、环境、模型继承及 child 数量/深度限制            |
| [get-child-status](../packages/sandbox-runtime/src/sandbox_runtime/tools/get-child-status.js)   | 读取 child 结果、分页 trajectory                      |
| [send-child-prompt](../packages/sandbox-runtime/src/sandbox_runtime/tools/send-child-prompt.js) | 对直接 child 追加消息                                 |
| [trace 导出器](../scripts/export-openinspect-trace.mjs)                                         | 递归发现 session、分页导出、manifest 与哈希           |
| [宿主机采集器](../packages/opensandbox-infra/collect.py)                                        | 容器身份、runtime 日志和资源观测                      |
| [trace 分析工具](../tools/openinspect-trace-analysis/README.md)                                 | 已有离线分析与批量汇总                                |
| [backend 观测约定](SANDBOX_BACKEND_PREPARATION.md)                                              | 启动阶段、时间与身份字段、证据限制                    |

交接时确认的实现事实：

- 本地 backend 已支持正常 API 提交、独立 child sandbox 和 trace 收集，不需要云部署。
- 现有 runner 只给 children 分配相同的短命令，并检查固定结果标记。其工具事件验收最多读取 200 条，遇到
  `hasMore` 直接失败；长任务必须使用正确分页。完整 trace 导出器已有分页逻辑。
- provider 使用部署配置中的固定 `OPENSANDBOX_IMAGE`，拒绝
  `prebuiltImageId`；不能假定 benchmark 的 Docker 镜像已经能作为任意单题环境传入。
- 本地 backend 不支持 snapshot/restore、持久化 resume、仓库镜像构建和额外 tunnel ports。
- `spawn-child` 继承仓库等配置，不继承父对话。创建路由使用父会话的 base
  branch，不能假设它会继承父 workspace 当前 HEAD 或未提交修改。
- `get-child-status` 中的完成回复不等于代码已经传入 parent workspace。
- 现有 smoke 清理流程会移除容器。benchmark 必须在移除前持久化代码和其他必要产物。
- `npm run trace:batch` 已存在；可复用 `block-d0-v1`
  等已有 profile，但需核对当前实现。精确重复操作与可消除的语义冗余不是同一指标，不能过度解读。

## 3. 上游资料与数据落盘

已阅读的一手来源：

- [FeatureBench 源码与 README](https://github.com/LiberCoders/FeatureBench)
- [FeatureBench 数据](https://huggingface.co/datasets/LiberCoders/FeatureBench)
- [FeatureBench 推理参数](https://github.com/LiberCoders/FeatureBench/blob/main/docs/infer_cli_arg.md)
- [FeatureBench 评分参数](https://github.com/LiberCoders/FeatureBench/blob/main/docs/harness_cli_arg.md)
- [FeatureBench 配置](https://github.com/LiberCoders/FeatureBench/blob/main/docs/config.md)
- [CooperBench 源码与 README](https://github.com/cooperbench/CooperBench)
- [CooperBench 数据](https://huggingface.co/datasets/CodeConflict/cooperbench-dataset)
- [CooperBench 任务说明](https://cooperbench.com/)

实施时固定实际下载的 Git
SHA、数据 revision、镜像 digest、评分器版本及依赖版本。上游 README 与代码可能存在变化或不一致，以固定版本的实际实现和校准结果为准。

建议外部根目录：`/home/liuyihua/Dev/RA-Agent/benchmark-lab/`。这是默认建议，使用配置或环境变量指定，避免把机器绝对路径写死进通用脚本。

```text
benchmark-lab/
  sources/           # 两个 benchmark 源码 checkout
  datasets/          # 固定版本的完整任务数据；评分器侧使用
  task-workspaces/   # 分离出的干净任务初始代码
  cache/             # HF、下载、依赖、构建缓存等
  runs/              # 批次状态、代码产物、trace 和评分报告
```

仓库内保存适配代码、版本锁定信息、15+15 题清单、可共享配置和运行手册。下载/评分工具默认可能往当前目录写
`dataset/`、`runs/`、`logs/`，应显式指定外部路径或 cwd。密钥使用已有私有配置或环境变量引用，不复制到文档、任务 manifest 或可共享 trace。Docker 镜像在 Docker 自身存储中管理，不要求搬迁宿主 Docker 数据目录。

## 4. 选题及无模型校准

### FeatureBench：15 个独立任务

- 优先检查 `v1.1` 数据的 `fast` 子集。调研时该子集有 100 题、无需 GPU。
- 第一版优先 Level 1，评分文档说明只有 Level 1 提供 gold patch。
- 每题至少存在两个实质子任务，可分别推进并在最终解里集成；不能只是把同一题重复交给两个 child。
- 覆盖多个仓库和功能类型，避免把同一底层功能的 Level 1/2 变体算作两个独立任务。
- 若 fast/Level 1 中无法选足合格 15 题，检查 CPU 可执行的其他候选，记录调整依据。

### CooperBench：15 个 feature pair

- 本方案将一题定义为 `repo + task_id + feature_ids` 指定的一对 feature，保留两份原始 feature
  prompt。
- 15 对对应 15 次父任务尝试，每次拟由两个 children 分别实现 feature；不是只选 15 个单 feature。
- 覆盖不同仓库、语言和潜在冲突类型，并尽量减少相同 feature 在多对中的重复。
- 固定官方数据与评测版本。当前 README 已包含 `solo`、`coop`、`team`
  模式，不能沿用旧介绍就假定最新协议和评分语义。

为每题记录：task
ID、来源版本、起始 commit、环境标识、入选理由、分工依据、资源需求、初始化步骤、参考解、评分入口及所需产物格式。分工依据用于选择与审计，不应把从参考答案中获得的实现方案泄漏进 agent
prompt。

在模型调用前对全部 30 题完成校准：

1. 在正确初始状态执行测试，核对官方预期的失败与回归测试表现。
2. 在独立环境应用参考解，确认评分器给出预期结果。
3. 对 CooperBench 核对 feature
   patch、测试 patch 及组合/合并的具体规则，不假定参考 patch 可任意相加。
4. 记录用时、依赖问题与测试波动，形成校准报告。

环境有缺陷的题可有记录地替换。模型失败的题不得为提高成功率而替换。选题清单在正式运行前冻结。

## 5. OpenInspect 接入设计

目标链路：

```text
固定任务 manifest
  -> 正常 OpenInspect API 创建 parent、提交 prompt
  -> parent 调用 spawn-child 创建独立 sandbox
  -> child 初始化、执行、提交代码产物
  -> parent 收集、协调、集成
  -> 持久化最终代码和完整 session 树证据
  -> 干净环境中的官方评分器
  -> 清理、trace 校验和批量分析
```

### 环境与任务起点

先验证复用 benchmark 镜像并加入 OpenInspect
runtime 的可行性，尤其是 Python/Node/toolchain 和 entrypoint 的兼容性。必要时补充最小的任务环境选择和继承能力，或采用经过验证的其他方案。不要把“官方提供 Docker 环境”当作它已经兼容现有 provider。

适配层确定性地初始化基础代码、任务要求的功能移除状态、依赖与工作目录。每个 child 都能校验 task
ID 和起始状态，不能依赖模型自行猜测版本或父会话临时 checkout。保留同任务共享初始环境的能力，避免为每个 child 重复联网安装全部依赖。

完整数据集、gold
patch、未来 Git 历史和官方隐藏测试保留在评分侧；agent 可见内容遵守各 benchmark 原有规则，不额外泄漏答案，也不无故剥夺原本可见的测试。不要为了初始化公开仓库而默认要求用户的 GitHub
App 安装到所有上游仓库；检查是否能通过本地干净任务副本接入。

### Prompt 与拓扑

第一版建议统一一个 parent + 两个 children，使用同一已配置模型与 reasoning 设置，禁止继续创建后代。这是便于比较的初始方案；模型、预算和具体协议仍需在实现中明确写入配置。

保留原 prompt 字节内容，追加单独版本化的实验附录，保存附录 hash 和实际提交的完整 prompt。例如：

> I explicitly request exactly two child sessions, each in a separate sandbox, using `spawn-child`.
> Assign each child a distinct, substantive part of this task. Create both children before waiting
> for either result. Use `get-child-status` to retrieve their results, integrate their changes, and
> validate the final solution. Do not substitute in-process Task subagents for these child sessions.
> Instruct both children not to create further child sessions.

FeatureBench 让 parent 根据原需求拆分；CooperBench 将原始两个 feature 分别委派，不要把两个相同的完整任务重复交给 children。child
prompt 必须包含完成任务所需的独立上下文。创建两个 child 后再等待，不强迫 shell 命令连续重叠；记录实际的消息、工具与 setup 并发。parent 通过
`get-child-status` 获取结果，按需使用 `send-child-prompt` 协调或要求返工。

CooperBench 的 OpenInspect 父子结构和原始 peer 结构存在差异。明确记录 parent 可见的信息、是否允许 parent 修改代码、通信方式和额外模型预算；结果标为采用 OpenInspect 协议的实验。若保留官方评分，分别保存其结果和 parent 集成/修复后的额外结果，不混成一个官方分数。

此处 child
sessions 指被测 OpenInspect 系统的会话，不是要求实施工作的 Codex 自动启用自身 sub-agents。

### 产物回传与评分

实现可靠的本地产物传输/引用机制，使 parent 能取得 child 的实际代码，不依赖自然语言“完成”声明。按 task、attempt、session 隔离产物，保留 child 原始 patch、parent 集成修改和最终代码。完整处理新增/未跟踪文件、删除和必要的二进制产物，不只运行会漏掉新增文件的简单
`git diff`。

原始产物在清理前落盘；runner 故障或 sandbox
TTL 到期也应尽可能留下可恢复的部分产物。官方评分在独立干净环境执行，不能只根据模型自己运行的测试或最终回复判断正确性。核对 FeatureBench 默认跳过失败 predictions、报告可能按 best
attempt 汇总等行为，使全量 attempt、失败与所报告的分母一致，不产生成功样本偏差。

## 6. 批量 runner 与证据要求

拟定统一接口：任务准备、运行、产物提取、官方评分；两个 benchmark 保留各自的适配细节。复用正常 API 提交链路，不用宿主脚本直接调用模型来替代被测系统。

runner 至少负责：

- preflight：服务连通、凭据可用、镜像存在、磁盘/内存、模型设置和 child 配额。
- 持久化任务、批次和 attempt 状态，以及 session/container 身份。
- 控制并发题数和总 sandbox 数，并把评分容器、parent、children 的资源开销纳入容量估计。
- 固定每题时限、模型预算、child 上限和重试政策，区分 setup 超时、sandbox TTL、运行截止时间。
- 写入 run ID 后再提交工作；考虑 API 超时后提交结果不明的对账，避免无条件重发创建请求。
- 锁或等价机制防止新 session 重复启动同一批次；日志及进度不依赖当前 Codex 的内存。
- 失败与中断也导出证据，重试产生新 attempt 并保留旧结果，不重复运行直到模型成功。
- 在采集完成后清理本批次拥有的资源，不清理其他实验或开发容器。

批次恢复与 sandbox 恢复必须区分：服务仍在运行时可以重新挂接观察；sandbox 已丢失时，当前 backend 只能将原尝试标记中断，再启动新尝试。不要声称现有本地 backend 能恢复丢失的 agent
workspace 或模型上下文。

每个 attempt 的结果至少包含：

- 任务版本、OpenInspect/runtime/adapter 版本、实际模型与 reasoning、资源设置、缓存条件。
- 原 prompt、附录、实际提交 prompt，以及实际 child 分配和通信。
- root/child session ID、sandbox/container ID、启动 attempt ID 与父子关系。
- 完整分页消息/工具事件、runtime/setup 日志、宿主机观测与覆盖缺口。
- child 与 parent 的代码产物、官方评分日志、结束原因、清理结果。
- trace manifest、文件 hash、已有分析工具的报告及使用的 profile 版本。

将下列维度分开保存：模型执行状态、child 协议是否满足、benchmark 正确性、trace 完整性、基础设施故障和清理状态。模型解题失败但 trace 完整仍是有效观测；没有实际 child 或证据缺失不能冒充合格 fan-out 样本。parent 回复结束不代表所有 children 已结束，终止判断应依据完整 session 树。

运行时间区分启动、setup、模型执行、等待、集成、评分和导出。不要把消息区间重叠声称为 shell 执行重叠；采样峰值内存不是精确 lifetime 峰值。成功与失败都进入 attempt 级汇总，并报告同一任务重复运行的关系。

## 7. 验证顺序与完成标准

按顺序推进，保持进度记录，不在“脚本写出来”处停止：

1. 下载并锁定版本，形成候选及最终 15+15 清单。
2. 全部 30 题完成无模型的起始状态与参考解评分校准。
3. 每个 benchmark 先各选一题完成真实 OpenInspect parent/child 端到端试跑。
4. 修复接入问题，完成 30 题低并发单轮验收，区分模型失败与接入失败。
5. 验证中断、批次恢复、避免重复提交、失败导出及清理路径。
6. 固定正式配置及默认入口，复用现有 trace 批量分析并产出汇总。
7. 用仅依赖仓库文档、落盘配置与状态的启动/接续流程验证新会话交接。

参考正式规模为 30 题 × 3 次 = 90 次父任务尝试；若全部遵循两 child 协议，对应 180 个 child
session。**这只是前一轮建议，尚未确定模型、预算和重复次数。**
先利用试跑测得的开销设置有限预算与并发，再启动正式多轮批次。已有配置可用时直接复用并记录；确实缺失模型、凭据或必要资源时明确报告缺项，继续完成不依赖它的工作。

必要测试依变更范围选择：共享类型变更先构建
`@open-inspect/shared`；相关 TypeScript 使用 Vitest，runtime
Python 使用 pytest。会话/继承改动应覆盖真实 D1/DO 集成行为；trace 改动运行已有导出与分析测试。不需要为单纯文档或配置描述添加镜像式测试。

当前已有命令：

```bash
npm run test:trace-export
npm run test:trace-analysis
npm run trace:analyze -- /absolute/path/to/trace --out /absolute/path/to/analysis
npm run trace:batch -- --help
```

拟定新增命令，**目前不存在**，实际实现可以调整但需更新运行手册：

```bash
npm run bench:doctor
npm run bench:prepare -- --suite pilot-30
npm run bench:run -- --config experiments/pilot-30.yaml
npm run bench:resume -- --run-id <run-id>
npm run bench:report -- --run-id <run-id>
```

最终交付包含：适配代码、外部材料路径与版本记录、30 题清单、校准报告、真实试跑证据、可恢复的 runner、默认配置和运行手册。实现完成后再为根
`AGENTS.md` 增加简短的运行手册入口，让新会话知道“开始实验”对应的命令和如何寻找已有批次。

## 8. 新会话开场指令

可以直接把以下文字发给新会话：

> 请阅读
> `docs/BENCHMARK_EXPERIMENT_HANDOFF.md`，继续实施 FeatureBench 和 CooperBench 的实验准备工作。两个 benchmark 各选 15 题，下载材料放在当前仓库之外，接入本地 OpenInspect/OpenSandbox，明确使用独立 sandbox 中的 child
> sessions，并完成任务评分、trace 收集、批次恢复和运行说明。先核对工作区与已完成事项，按交接文档推进实施及必要验证，持续更新落盘进度。最终使后续新会话收到“开始实验”的指令就能启动或接续实验。

新会话的第一步是检查当前代码/进度，读取第 2 节的本地入口，然后下载固定版本并检查真实数据结构。无需重做已经完成的 benchmark 广泛调研。尚未实现的接口不要当作可直接执行的现成命令。
