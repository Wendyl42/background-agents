# CooperBench 实施进度

更新时间：2026-09-09。**15/15 官方校准、15/15 干净起点、15/15 最终 runtime 镜像、15/15 实验用户权限检查和 15/15
overlay 评分等价性验证全部完成并通过。**
选题已冻结，尚未运行模型。阶段 1 与阶段 2a 已独立验收 PASS；最终实验准备证据等待独立验收收口。

- 已读取交接文档和根 AGENTS.md；源码工作区干净，未重置。
- 固定源码：`b0262a7b64df945944b5063745369bb2d78d4b57`。
- 官方源码包含完整 dataset，官方 `dataset/README.md` 明确支持使用 GitHub
  dataset 树或匹配版本的 Hugging Face mirror。因此采用 GitHub 同 SHA 的数据，避免混用 HF 最新版本。
- 外部根：`/home/liuyihua/Dev/RA-Agent/benchmark-lab`；源码在
  `sources/CooperBench`，完整 771 个数据文件复制至
  `datasets/cooperbench-b0262a7b64df`；全量 SHA-256 清单在
  `datasets/cooperbench-inventory.json`，清单摘要在仓库锁文件。
- 最终 15 对已写入
  `experiments/cooperbench-tasks.json`：8 仓库，Python、Go、TypeScript；每对两个不同 feature，跨题无重复 feature。每题记录原文路径、字节数和哈希、起点、镜像、入选/分工依据及评分材料。每对都已通过原始失败、两份单独参考通过、combined 参考双测试通过的校准。每题锁定不可变校准报告路径和 SHA-256。
- 15 题官方镜像 registry manifest digest、config digest、实际本地 Docker image
  ID 均已锁定；源码起点、runner 哈希与源文件 tree 也逐题验证。
- 已实现 `tools/benchmark/cooperbench.py` 的
  `bootstrap`、`prepare`、`calibrate`、`score`、`pull`、`verify-agent`。仅用标准库调用 Docker，实际评分函数从固定源码加载，替换传输依赖、不引入模型 SDK。
- `docker pull` 首次失败：daemon 无代理，连接 Docker
  Hub 解析地址超时。宿主 Python 通过已有 HTTPS_PROXY 成功访问 registry（401 是预期鉴权响应）；改用公共
  `tools/benchmark/pull_image.py` 经代理下载、逐层哈希验证并 docker load，不修改 daemon 配置。
- 无模型校准按每题 base 两份测试、individual gold 两份测试、combined
  gold 两份测试执行。每次校准独立保存 attempt 目录，任务级 calibration.json 只是最新状态，不覆盖旧尝试。评分容器无网络、2
  CPU / 4 GiB 配额，Docker transport 原始命令输出及 cleanup 结果落盘。

## 已核对的评分语义

固定版本 `src/cooperbench/eval/sandbox.py` 是实际评分入口。README 的“individual
patch”简述不完整：coop/team 使用两个 child patch 建分支后 naive merge，再分别运行两份 feature
tests。相同 patch 有专门 normalization；发生 merge conflict 或 patch apply failure 时，只允许 agent1
patch 单独同时通过两份测试作为回退；当前 Docker 路径不使用 union fallback。评分器过滤 agent
patch 中的测试文件，保留原始产物但按上游规则评分。

官方 `dataset/README.md`
明确要求：每份 feature.patch 独立通过自己的 tests.patch；原始 base 必须失败；combined.patch 是整 PR 已解决冲突的参考解，必须通过所有 feature
tests。两份 gold feature
patches 不保证可合并（官方全量 652 对中 499 对有冲突）。校准组合参考解使用 combined.patch，不把 gold 合并冲突冒充环境缺陷。

OpenInspect 协议记录两类结果：

1. 原始两个 child patch 按清单 feature_ids 次序送入官方 test_merged；首个 child 是上游 agent1。
2. parent 集成和修复后的最终 patch 使用官方 test_solo 测试逻辑，明确标记为 OpenInspect parent
   integration。它增加一个可见两份需求且可改代码的 parent 模型预算，不能替代原始 child
   patch 分数或声称等同官方 peer 实验。

## 当前落盘证据与剩余工作

外部 `runs/calibration/cooperbench/summary.json` 汇总官方 15 题通过状态及最终环境验证索引。最终代际
`runs/calibration/cooperbench/final-20a32f60-20260909T065404Z/` 包含：

| 文件                               | 实际结论                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `build.json`                       | 15 个最终镜像构建/复用完成，固定源码 hash 均未变化                                |
| `verification.json`                | 15 题用户权限与完整官方 overlay 校准均通过，含精确镜像 ID、原始报告路径和 SHA-256 |
| `final-evidence-verification.json` | 15 题报告哈希正确，公共 freeze 会选择同一最终镜像的通过报告，runtime 来源核验通过 |

`verification.json` 的 SHA-256 为
`2cc87de829b327ef222258e9e1a282c4eb7db4a6b2bfa0bd39594e0bf1c4ca38`，已写入仓库锁文件
`final_runtime_validation`。每次原始 transport 输出、旧失败尝试和旧镜像代际均保留。

选题清单状态为 `frozen-after-official-calibration`；锁文件 `selection_manifest_sha256`
按格式化后的清单原始字节计算 SHA-256。后续由独立验收代理收口本阶段，真实 parent/child 实验及公共报告按
[公共运行说明](../BENCHMARK_RUNBOOK.md) 执行。

## 校准中发现的问题与修复

- dirty-equals 的官方 runner 每次安装 editable
  package 会启动隔离构建，纯离线时缺少 poetry-core。已下载并锁定 poetry-core 2.2.1、setuptools
  75.8.0、wheel 0.45.1，通过只读 wheelhouse + `PIP_NO_INDEX=1` / `PIP_FIND_LINKS`
  保持测试代码不变。锁文件保存 wheel SHA-256 与官方 PyPI 下载 URL，缺失时可重建，不依赖当前会话。
- Go runner 使用 `set -e`，失败的 `TEST_OUTPUT=$(go test ...)`
  会在打印之前退出，原日志缺少真正失败原因。base 校准用 `bash -x`
  暴露实际失败输出；模型/参考评分仍执行固定上游函数，未改测试或判定规则。
- 原候选 `go_chi/task56/[1,5]` 的 feature 1
  gold 在真实官方镜像中失败：Allow 头测试要求特定顺序，实际得到 `HEAD GET`。诊断保存在原题
  `gold-diagnostic.json`。替换为同 task `[2,4]`，独立 core invalid-method handling 和 reusable
  method validation middleware。替代题已通过完整无模型校准，原失败证据保留。
- 阶段 1 独立验收已 PASS，见 `STAGE_REVIEWS.md`；Go56 替换与全部环境校准将在阶段 2 再审。
- Go26 使用 Alpine 官方镜像，公共 runtime 已验证独立工具链跨 libc 可启动；overlay 的评分等价性另行实测。
- 已实际验证 score 接口：dirty-equals 两份独立 gold patch 的官方合并结果为 conflict/false，parent
  combined gold 为 true，两类结果严格分开。证据在该题
  `score-interface-check-v2/score.json`，最新生命周期状态为 `complete`；旧接口证据保留。
- 公共 runtime 曾修复产物传输和 Python 路径，旧 overlay
  ID 的 parity 计划已取消；最终校准必须记录与 runtime.json 一致的实际 image ID。
- 离线 wheelhouse 另补充 flit-core 3.11.0（Click/Jinja build）和 pyarrow 20.0.0 的 CPython 3.12
  Linux wheel（官方 datasets
  runner 会先卸载再安装它）。每份文件的 hash 与下载 URL 均已锁定，评分前拒绝未锁定的额外 wheel。
- DSPy 官方镜像单独降级 litellm 后，原 runner 重装 dev extras 需要匹配的 proxy 依赖。补齐
  `litellm[proxy]==1.77.1` 对应 97 份 CPython 3.11 Linux wheels，逐份核对 PyPI
  URL/SHA-256；连同上述依赖共 102 个锁定 wheel。DSPy 两份 baseline 均为 4 failed/10
  passed，单独 gold 和 combined 均通过，最终全部 15 对通过。
- 离线 wheelhouse 是明确的环境适配：若模型新增未缓存的第三方依赖，安装可能失败；应保留为环境/依赖证据，不能隐瞒为纯功能失败。
- 准备工作区时，datasets 含已跟踪但被 .gitignore 匹配的原始 fixtures，Pillow 含未初始化 gitlink。已用原始 tracked 文件列表强制建索引，并还原原始 tree 索引（保留 gitlink，不带目标 commit 历史）；新 root
  commit 的 tree 必须与官方完全相同。旧失败 prepared 元数据和诊断保留，不能用于运行。
- 独立验收指出 score 的中途文件可能被误认完成。已修复生命周期：开始及 child 完成后
  `status=running`，两类评分执行完且产物齐全才 `complete`；缺产物为 `missing_artifacts`
  且带明细，异常为 `infrastructure_error` / `interrupted`
  并保留部分结果。已有 score.json 拒绝覆盖，恢复必须创建新 scoring
  generation。7 项生命周期检查通过；另以实际 Docker 验证三个空补丁得到
  `status=complete`、两类分数均 false（`adapter-state-check/empty-artifacts-score/score.json`），不会误记基础设施错误。生命周期证据在
  `runs/calibration/cooperbench/adapter-state-check/result.json`。

## 最终 runtime overlay 验证

独立阶段 2a 已 PASS。最终 core 为
`sha256:20a32f60311a04e2e8a4cdba230c293b04db963eef3d4a4872c8e0ab5b334269`，全部 15 题使用该 core。Go26 复用同一已验收镜像，其余题按最终模板重建；environment、launcher、configure、artifacts 的固定源码 SHA 均逐操作核对。每题 runtime.json 的 core、脚本、Dockerfile 和 prepared 哈希也通过公共来源检查。

所有 15 题均以 UID/GID
10001 和 no_new_privs 实测 Python/Go/TypeScript 基础工具、目标包导入（Python）、原始 tracked 测试可读、工作区可写，以及 runtime 私有 Python/Node 依赖不可读。权限检查调用真实 launcher 初始化工作区，每项保存命令、退出码、输出和耗时；该检查独立于使用原官方 root
harness 的评分。每题检查用时 2.23–9.58 秒。

全部 overlay 的 baseline 两份测试均真实失败，两份 individual gold 各自通过，combined
gold 同时通过两份测试；baseline 与 individual
gold 的通过/失败测试计数、combined 的结果也逐项与官方镜像一致。15 题 overlay 校准累计约 1,399 秒，串行且每个评分容器限制为 2
CPU / 4 GiB、无网络。未调用模型。

权限复测现在尊重 `--output`；默认保存至
`overlays/<image-sha>/agent-<uuid>/agent-environment.json`，原子拒绝复用已有报告，不再覆盖旧的 latest 别名。此前最终 15 题报告与
`agent-environment-<id>.json`
历史副本保持原路径及哈希；公共入口实际复测 Go26 后，原最终证据已恢复并核验，记录在
`runs/audits/cooperbench-agent-report-restoration.json`。每次校准默认使用独立
`attempt-*/calibration.json`，也可显式指定新外部目录。最终报告包含
`grading_image_id`、`official_reference_sha256` 和
`environment_equivalence`，不会把旧镜像的通过结论用于新镜像。

历史候选 core `24220fe0...` 的 5 题通过报告保留在
`overlay-generation1-parity-summary.json`；旧 runtime 完整目录归档于
`task-workspaces/<taskId>/runtime-overlay-generations/<image-sha>/`。曾实测 React153 重复 chown 导致约 248 秒权限检查；launcher 加入 lstat 所有权判断后，一次性修复验证为 1.879 秒，最终 core 下真实 launcher 为 2.343 秒、完整权限检查为 4.269 秒。历史暂停与已结束构建证据也均保留。

```bash
python3 tools/benchmark/cooperbench.py verify-agent \
  --task-id cooperbench-go-chi-26-1-2 \
  --image-id sha256:ACTUAL_FINAL_RUNTIME_IMAGE_ID \
  --output "$BENCHMARK_LAB_ROOT/runs/audits/go26-agent-new-attempt"
```

## 新会话与新机器重建

宿主要求 Linux amd64、Python 3.11+、Git、可用的 Docker
CLI/daemon。CooperBench 适配器只使用 Python 标准库，不需要安装上游 venv、模型 SDK 或上游 uv.lock 依赖。官方环境依赖由固定镜像提供，额外 102 个评分 wheel 按锁文件 URL/SHA-256 自动下载。公共 OpenInspect
runtime 的构建和私有配置另见公共运行说明。

`bootstrap`
是仓库内可执行的完整入口：仅在 source 不存在时 fetch 指定 SHA，已有 source 必须版本正确且无本地改动；通过 Git
tree、771 文件总数/字节数及全量文件 hash 重建数据；校验 evaluator 与 uv.lock；校验或下载所有 wheel；经公共 pull_image.py 下载固定 manifest/config 镜像。复用本地缓存时仍验证内容。已有冲突文件直接失败并保留，不自动重置。Docker
classic/containerd 的本地 ID 可能不同，复现身份按 registry
manifest/config/RootFS 验证，本机实际 ID 另记。

锁文件的 dataset
inventory_sha256 使用按键排序、紧凑 JSON 的规范字节（无末尾换行）；inventory_file_sha256 是落盘可读 JSON 的原始字节哈希。两者算法明确区分。

```bash
export BENCHMARK_LAB_ROOT=/absolute/external/benchmark-lab
# 网络需代理时，使用该机器实际 HTTP(S)_PROXY；不修改 Docker daemon 配置
python3 tools/benchmark/cooperbench.py bootstrap
# 只重建源码/数据/评分 wheels，不拉取大镜像
python3 tools/benchmark/cooperbench.py bootstrap --skip-images
# 单题仍重建完整固定数据与共用依赖，只限制镜像数量
python3 tools/benchmark/cooperbench.py bootstrap \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3
```

已在初始为空的外部 `reproducibility/cooperbench-clean-room`
实测固定源码、771 数据文件、102 个 wheel（163,278,898 字节）的网络重建。镜像复用同一 Docker
daemon 已有内容，在全新 OCI metadata 缓存中验证全部 15 个 registry
manifest/config/RootFS。随后将所有代理临时设为不可达端口，完整 bootstrap 仍成功，证明固定缓存可离线接续。准确范围、首次 TLS
EOF 及有限重试、日志哈希见 `runs/calibration/cooperbench/bootstrap-verification.json`。

完成报告在
`runs/bootstrap/cooperbench.json`。首次全部镜像下载需要数十 GB 外部磁盘；prepare、calibrate 均可用同一入口继续，不依赖外部一次性 worker 脚本。

## 单独使用适配器

```bash
export BENCHMARK_LAB_ROOT=/home/liuyihua/Dev/RA-Agent/benchmark-lab
python3 tools/benchmark/cooperbench.py bootstrap
python3 tools/benchmark/cooperbench.py calibrate
python3 tools/benchmark/cooperbench.py prepare

# 只处理单题；重复传 --task-id 可选多题，默认串行
python3 tools/benchmark/cooperbench.py calibrate \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3

# 显式官方输出放在该题校准根下，供后续 overlay 自动发现；目录不可复用
python3 tools/benchmark/cooperbench.py calibrate \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3 \
  --output "$BENCHMARK_LAB_ROOT/runs/calibration/cooperbench/cooperbench-samuelcolvin-dirty-equals-43-2-3/official/new-attempt"

# 原始 child patches 严格按清单 feature_ids 顺序传入，parent 分数单独报告
python3 tools/benchmark/cooperbench.py score \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3 \
  --child-patch /absolute/attempt/feature2.patch \
  --child-patch /absolute/attempt/feature3.patch \
  --parent-patch /absolute/attempt/parent.patch \
  --output /absolute/attempt/scoring

# 检查公共 runtime overlay 与官方环境的 base/gold 等价性
python3 tools/benchmark/cooperbench.py calibrate \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3 \
  --image-id sha256:ACTUAL_RUNTIME_IMAGE_ID
```

prepare 输出在外部 `task-workspaces/<taskId>/prepared.json`，包含清理后 immutable
baseImage、单 commit baseline、两份原 prompt 路径、原始 source archive 和哈希。仓库依赖保留在原路径
`/workspace/repo`；原始可见测试保留，full Git 历史、remote、
`/patches`、评分 runner 移除。agent 不得访问 Docker socket 或评分材料目录。

score 输出 `score.json` 与 transport 日志。`official_child_patches`
是固定官方 test_merged 结果，`openinspect_parent_integration`
是 parent 最终 patch 的 test_solo 结果。calibrate 不带 `--output`
时生成独立 attempt 目录并保留任务级 calibration.json latest 兼容别名；显式 `--output`
仅支持单题，原子拒绝复用已有报告，且不更新任何旧别名。`passed`
必须 true。overlay 从该题标准校准根中排除 overlays 后，选择最新官方 immutable
attempt 报告；存在旧 latest 别名时，先核对其对应不可变副本的 SHA-256。显式官方输出应放在该题校准根下，任意根外目录不会被自动发现。overlay 校准在
`overlays/<local-image-sha>/` 独立保存，并记录官方与实际评分 image
ID；仅在评分容器内重新注入官方 runner，agent 镜像本身保持无评分材料。

输出生命周期修复已通过公共 CLI 对 dirty-equals 单题的官方与最终 overlay 实测，两次均 PASS。overlay 引用本次新官方不可变报告及 SHA-256；重用同一输出目录真实拒绝，全部既有 calibration/agent 报告哈希保持不变。证据为
`runs/audits/cooperbench-calibration-output-20260909T081346Z/result.json`。验证在外层持有 FeatureBench 评分互斥锁，未重跑其余 14 题、未调用模型；独立复验由主 agent 安排。
