# FeatureBench 实施进度

更新时间：2026-09-09。材料根通过 `BENCHMARK_LAB_ROOT` 指定；本机为
`/home/liuyihua/Dev/RA-Agent/benchmark-lab`。

当前快照（2026-09-09 10:10 UTC）：FeatureBench实施已完成，当前15个fast
Level1独立任务覆盖14仓。官方初始/gold校准、有效prepared/runtime、当前镜像overlay校准、真实UID检查均15/15全部通过，43项公共测试与Ruff通过。最终清单SHA为`ddd1afd400a6ae2fb1eb772ffbf2913542569dd19a0928d66a720a97e79035d1`。仅状态字段增量更新，原任务身份、prompt和分工完全不变；已提交独立全阶段终验，正式freeze由主agent执行。模型调用仍为0。

当前15题的权威汇总是仓库外
`runs/calibration/featurebench/current-selection-index.json`，逐题关联实际prepared/runtime身份与官方、overlay、UID报告SHA。早期
`{index,overlays-index,agent-environments-index}.json`
属于原选题worker，保留已退休失败及被新generation替代的历史结果，不能直接作为最终15题通过计数。以下阶段记录保留当时状态；最后的资源分槽记录描述当前准备/评分上限。

## 阶段 1：下载与候选清单

- 已核对源码 SHA `8d4e347ec57546685c5a87e8676bf575db022ea6`，没有重置 checkout。
- 已下载 v1.1 对应实际数据 SHA `76b4a4566e04f4bcc13c35125d4f301791efa736`
  的 fast/full/lite 全部 parquet 和 README，并在仓库外转换为 JSON；hash 记录在
  `experiments/featurebench-lock.json`。
- fast 实际 100 题全部 Level
  1，覆盖 18 仓库；已依据原始需求选 15 题覆盖 15 仓库，各有两条实质工作流和集成边界，见
  `experiments/featurebench-tasks.json`。未把 mask patch 的代码方案用于选题附录。
- 候选尚未冻结：必须完成全部 baseline/gold 校准后才能标为正式清单。明显只有一小段实现的候选（例如 mypy
  Constraint equality、pandas Expression repr、Sphinx doctest predicate）未选入。
- Docker 可用但原先无 FeatureBench 镜像；隔离评分依赖安装于
  `cache/featurebench-venv`，第一张 packaging 镜像正在拉取。

## 阶段 2：接入与校准（进行中）

上游 `patch` 是功能删除 patch，gold 要反向；`test_patch`
用于评分时反向恢复 F2P 测试。原 prompt 保留 UTF-8 字节，不注入选题分工依据。

官方镜像含 `/root/my_repo`
完整代码。准备时必须采用官方推理初始化（mask、F2P 删除、原始副本删除、`.git` 重建、bytecode/package
cache 清理）并审计后生成可供 agent 使用的环境。不能将原镜像直接交给 agent。

官方 `run_instance_level1` 对空 prediction 直接返回 Empty
patch。baseline 校准将记录一个新增无害 sentinel 文件的 patch，以进入真实官方测试路径；这不是模型提交。模型空 patch 仍保留并按官方失败计分，不替换为 sentinel。

计划接口：`python tools/benchmark/featurebench.py {prepare,calibrate,score} --lab-root <external-root> --task-id <id> --output <external-output>`。实际命令实现与校准结果后续追加；当前未运行模型。

### 真实执行补充

- 全部 15 个官方镜像 tag 的 registry
  digest 已解析并写回清单和锁；独立于是否已下载。每张压缩镜像约 10–18 GB，fast 并不表示镜像轻量。
- Docker daemon 直连首张镜像失败（`registry-1.docker.io` TCP 超时）；现有 shell
  HTTPS 代理可访问官方 registry/auth。为此实现通用
  `tools/benchmark/pull_image.py`：固定 digest、linux/amd64、blob/解压后层哈希、磁盘缓存、Range 接续与有限重试，流式导入 Docker，未修改 daemon 配置。
- 小型 busybox 1.36.1 镜像实际下载与导入成功，再次执行成功复用本地镜像。当前 Docker containerd
  store 的本地 image ID 是导入后 manifest digest，区别于上游 config
  digest；工具分别记录并核对所有 RootFS diff IDs、Config 与平台。证据：外部
  `cache/oci-busybox-validation.json`。
- FeatureBench 首张 packaging 镜像已进入实际大型层下载；其余镜像先解析共享层容量。15 题尚未任何评分通过，不把正在下载记为校准完成。
- `featurebench.py` 已实现 prepare/calibrate/score。官方起点初始化复用固定
  `_initialize_level1`（仅省略与代码起点无关的 tmux/asciinema apt 安装）；独立评分复用固定
  `run_instance_level1` 及 report/parser。执行结果仍待实际验证。

### 接口与当前验证边界

适配器使用外部
`cache/featurebench-venv/bin/python`；本机锁定依赖版本均已通过 metadata 核对，15 条原 prompt
hash/base
commit 与固定 JSON 一致，15 条官方 gold 预处理均非空。Python 编译和 Ruff 格式/静态检查通过。这些检查不等于测试校准通过。

```bash
# 示例：首题官方初始状态 + gold 校准
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" tools/benchmark/featurebench.py calibrate \
  --lab-root "$BENCHMARK_LAB_ROOT" \
  --task-id pypa__packaging.013f3b03.test_metadata.e00b5801.lv1 \
  --output "$BENCHMARK_LAB_ROOT/runs/calibration/featurebench/pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/official-01"

# 干净agent起点（原prompt位于输出 prompt.original.txt）
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" tools/benchmark/featurebench.py prepare \
  --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id> \
  --output "$BENCHMARK_LAB_ROOT/task-workspaces/<task-id>"

# runtime叠加后验证：输入清理后的baseline commit，不是上游base commit
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" tools/benchmark/featurebench.py calibrate \
  --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id> \
  --prepared-image <runtime-image-id> --baseline-commit <prepared-base-commit> \
  --output "$BENCHMARK_LAB_ROOT/runs/calibration/featurebench/<task-id>/overlays/<runtime-image-attempt>"

# 模型产物统一使用实际patch；空patch也进入官方失败结果
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" tools/benchmark/featurebench.py score \
  --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id> --prediction-patch <artifact.patch> \
  --output "$BENCHMARK_LAB_ROOT/runs/<run-id>/<attempt-id>/score"
```

每次校准/评分必须使用新目录，避免覆盖旧结果。每阶段实际 container ID、耗时、退出原因和清理状态在
`score.json`；`official-report.json` 保留官方判定；`calibration.json` 的 `passed`
仅在初始 F2P 失败/P2P通过、gold通过且测试证据与清理齐全时为 true。

runtime 校准在全新评分容器核对 masked baseline，然后以该起点创建 `/root/my_repo`
临时副本、把官方删除 patch 设置为空，避免重复mask；其余预测patch、隐藏测试恢复、测试和评分逻辑仍调用同一官方函数。该路径尚待真实镜像校准。

镜像共享层实际调查：15张镜像重复相加约176 GB，唯一压缩层约90.15 GB（详见
`cache/featurebench-image-capacity.json`）。下载和评分均序列持久化，不因慢下载而冒报全部完成。

### 镜像传输的接续证据

- 固定 busybox manifest `sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f`
  在临时代理指向不可用端口时仍成功完成本地可用性检查：`cache/oci-busybox-offline-validation.json`。缓存manifest/config与本地镜像校验路径不依赖联网。
- 缓存按 blob digest、解压层 diff
  ID、镜像 digest 分别加文件锁；并发调用复用下载且不会重复同镜像导入。
- 首张 packaging 已完成 6.11 GB 基础大层，正在下载 3.00
  GB 单仓库依赖层；并行下载进程正处理后续 mlflow 镜像的独立基础层。当前没有 FeatureBench 测试容器，也没有 FeatureBench 模型调用。

- 镜像transport的故障路径开发检查已执行：拒绝非amd64配置、拒绝下载到当前仓库、离线固定manifest解析、拒绝已缓存但SHA不匹配的blob。记录在
  `cache/featurebench-transport-check-results.json`。这些是实现者的开发验证，不替代用户要求的独立阶段验收。

### 当前自动接续入口

外部 `cache/featurebench-calibrate-suite.py`
序列等待已下载镜像，再执行官方初始/gold校准与prepare。它的统一状态在
`runs/calibration/featurebench/index.json`（含PID、phase及逐题报告路径），stdout在
`cache/featurebench-calibration-worker.log`。当前 attempt 为
`20260909-official-01`；prepare输出统一到公共runner约定的
`task-workspaces/<task-id>/prepared.json`。读取PID/phase后再决定是否已有worker，避免重复启动；失败校准重试应使用新attempt保留旧记录。

## 首题实际官方校准结果

`pypa__packaging.013f3b03.test_metadata.e00b5801.lv1` 已完成官方校准，报告
`runs/calibration/featurebench/pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/20260909-official-01/calibration.json`
的 `passed=true`。

- 初始状态（sentinel-only patch）：F2P失败、全部P2P通过，60.856秒。
- 官方预处理gold：F2P与P2P通过、resolved=true，12.901秒。
- 两个评分容器均已删除，测试输出、官方report与容器ID均已落盘。
- 其余14题仍待镜像/校准；首题干净起点prepare正在执行。尚未运行任何FeatureBench模型任务，尚未冻结15题清单。

首个镜像pull进程在修复Docker containerd ID语义前已启动，实际docker
load成功后旧代码的末尾config-ID比较报错。后续worker使用已修复工具验证了实际镜像内容并成功评分；这次历史pull错误未被删除或冒报为下载失败的测试结果。

首题prepare现已完成（436.608秒），规范路径为
`task-workspaces/pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/prepared.json`，`ready=true`。清理后镜像为
`sha256:d648cec3d91f7798001b803503a50aa32daa7d5b3e6b254c9bbe4f1deed169b1`，唯一初始commit为
`1b1213bdbf5720b551372aad9ac9cd51f33d885a`；全镜像仅保留
`/testbed/.git`，原始F2P文件已删除，额外安装的packaging副本已指向masked源代码，flatten及容器清理均完成。仍需runtime叠加后的baseline/gold
parity验证。

FeatureBench的prepare/score现共享 `cache/featurebench-container.lock`，避免官方校准worker与runtime
parity同时占用两个FeatureBench容器；单套实验最多一个8GiB容器，配合CooperBench一个4GiB容器使用。

## 从新机器重建材料

仓库内 `featurebench.py bootstrap`
是可复现入口，不依赖本次外部临时worker。先具备 Git、Docker（可访问daemon）、锁定的宿主 Python
3.13.5；shell HTTPS代理会用于HTTP下载，无需修改Docker
daemon。全部缓存、源码、数据和评分依赖留在外部材料根。

```bash
export BENCHMARK_LAB_ROOT=/absolute/path/outside/background-agents/benchmark-lab

# 必须由 Python 3.13.5 执行；校验既有checkout，不重置它。
python3 tools/benchmark/featurebench.py bootstrap --lab-root "$BENCHMARK_LAB_ROOT"

# 顺序下载15张固定digest镜像；已校验缓存可接续复用。
python3 tools/benchmark/featurebench.py pull-images --lab-root "$BENCHMARK_LAB_ROOT"

# 单张镜像也可先准备，以缩短首次校准等待。
python3 tools/benchmark/featurebench.py pull-images --lab-root "$BENCHMARK_LAB_ROOT" \
  --task-id pypa__packaging.013f3b03.test_metadata.e00b5801.lv1
```

bootstrap从锁文件恢复源码commit、依赖精确版本、三份parquet及README，使用锁定pyarrow重建JSON并核对全部7份文件SHA；既有文件hash不匹配会拒绝继续。已在真实材料目录幂等执行成功，证据
`cache/featurebench-bootstrap.json`。也已在全新 `/tmp/featurebench-bootstrap-validation`
完成源码fetch、原始数据下载/转换及新venv依赖安装，7份文件SHA全部匹配，证据
`runs/audits/featurebench-fresh-bootstrap.json` 和同名log。该安装允许复用宿主pip wheel缓存。

下载后可仅使用仓库内接口执行全部官方校准与准备。下面脚本会保留既有同attempt结果，失败重试应换attempt值；不会运行模型。

```bash
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" - "$BENCHMARK_LAB_ROOT" official-01 <<'PY'
import json, subprocess, sys
from pathlib import Path
root, attempt = Path(sys.argv[1]), sys.argv[2]
tasks = json.loads(Path('experiments/featurebench-tasks.json').read_text())['tasks']
for task in tasks:
    task_id = task['taskId']
    output = root / 'runs/calibration/featurebench' / task_id / attempt
    report = output / 'calibration.json'
    command = [sys.executable, 'tools/benchmark/featurebench.py']
    if not report.exists():
        subprocess.run(command + ['calibrate', '--lab-root', str(root), '--task-id', task_id,
                                  '--timeout-seconds', str(task['environment']['testTimeoutSeconds']),
                                  '--output', str(output)], check=False)
    if not report.exists() or not json.loads(report.read_text()).get('passed'):
        continue
    prepared = root / 'task-workspaces' / task_id
    if not (prepared / 'prepared.json').exists() or not json.loads((prepared / 'prepared.json').read_text()).get('ready'):
        subprocess.run(command + ['prepare', '--lab-root', str(root), '--task-id', task_id,
                                  '--output', str(prepared)], check=False)
PY
```

## 副本审计修正记录

首题旧prepare只处理直接安装包，实际发现pip/setuptools/wheel/pkg_resources内部的vendored
packaging仍有被mask功能。已将prepare扩展为递归扫描安装树及build副本，重定向到同一masked
canonical源码，结果记录 `packageIsolation.auditVersion=2`。旧首题目录完整归档于
`runs/preparation-history/<task-id>/20260909-package-audit-v1`，修复后的prepare使用规范任务路径。MLflow先前准备镜像经相同全根扫描未发现残留目标包副本。

Meson补审发现
`/usr/lib/python3/dist-packages/mesonbuild`，也已归档v1准备目录并排队执行修复版prepare。后续任务在新CLI进程中直接使用修复后的递归规则。旧准备审计集中于
`runs/audits/featurebench-early-prepared-vendor-audit.json`。

实施层审计报告 `runs/audits/featurebench-runtime-source-copies.json`
包含15题被mask文件/定义范围，**仅限评分与环境实施侧，不可复制到prompt或agent资产**。runtime独立Python内实际含pydantic
2.13.5及pip vendored packaging；Pydantic
task固定源码版本为2.13.0a0+dev，8个受mask文件的同名功能仍存在。版本差异不能证明没有参考代码。公共overlay已着手权限隔离，需要真实agent身份检查与修复后环境parity一起验收。

最初首题runtime校准使用的旧image ID在等待容器锁期间被新构建替换/移除，最终以 `infrastructure_failed`
结束，未创建评分容器；历史报告 `20260909-runtime-01/calibration.json`
保留，不计为测试失败或校准通过。后续overlay报告路径统一使用 `overlays/<attempt>/calibration.json`
并锁定顶层 `preparedImage` 与 `baselineCommit`。

首题v2 prepare现已完成：19处目标包源码副本已重定向，耗时468.136秒，容器已删除；新sanitized镜像
`sha256:9a4ccc4057cfe7b993ec5f28c6a5ebd9fd8e63f6475b549081ccd33b270d306a`，源树baseline
commit保持不变。最终公共core身份隔离检查通过后，overlay
worker已启动：`cache/featurebench-overlay-suite.py`，索引
`runs/calibration/featurebench/overlays-index.json`，stdout
`cache/featurebench-overlay-worker.log`，attempt
`20260909-runtime-v2`。它只接受v2准备，或具有同镜像空副本审计的先前准备；每题调用仓库内公共CLI构建overlay及FeatureBench适配器重放baseline/gold，绝不调用模型。core镜像变更会停止此worker并要求新attempt。

对应可复现的单题公共命令（替换task-id后对15题依次执行）：

```bash
python3 tools/benchmark/cli.py prepare --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id>
python3 tools/benchmark/cli.py calibrate --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id> --overlay
```

prepare/score的新调用会在创建容器后立即保存ID；prepare还保存当前stage，便于识别初始化、包隔离、镜像flatten等长阶段。已经启动的进程使用其启动时的adapter
hash和行为，历史记录不回填为新版本。

prepare恢复语义：同一路径 `ready=true` 默认幂等返回；`ready=false`
的中断/失败结果会在获取准备槽锁、确认同task旧准备进程不再活跃后，清理同task且purpose=prepare的遗留容器，将适配器自有中间文件与日志归档到
`runs/preparation-history/<task-id>/<generation>/`，再创建新generation。调用方其他文件不移动。显式
`prepare --new-generation` 可归档并重做已完成准备；完成后必须重新构建关联runtime、使用新image
ID做overlay校准。真实Docker遗留容器清理、旧证据保留及非适配器文件保留均已开发验证通过，记录
`runs/audits/featurebench-prepare-recovery.json`。

公共launcher为避免重复chown导致巨大copy-up延迟作了所有权相等时跳过chown的修正。当前v2 overlay
worker父进程已暂停新构建，首题已有baseline通过预期失败/通过关系，gold仍继续等待执行；此代结果保留为历史。后续新代锁定launcher
SHA
`642ccb4cb9e9485f223a6382f682f150215379c3e010378515285d0769cbd936`，重新构建首题并校准。worker会记录并检查environment/launcher/artifacts源码hash；变化时停止下一题，避免同一代默默混用不同接入实现。

v2旧overlay首题现已完成：`passed=true`，baseline
F2P失败/P2P通过21.838秒，gold全部通过13.350秒，评分容器均删除。这证明递归vendor处理后的任务测试关系正常，但不是最终core校准。独立环境验收又提出root
Python启动导入路径与OpenCode自动重启路径需要收紧，公共core正在修正；因此旧worker已停止，索引保留在
`runs/calibration/featurebench/overlay-history/20260909-runtime-v2-index.json`，当前索引phase为
`paused_for_core_revision`。新core获验收放行后再新建generation，不提前启动模型或重用旧core成功记录。

Pandas准备发现v2按目录同名识别过宽：`hypothesis/extra/pandas`
是集成策略模块，不能替换；`build/cp311/pandas`
则包含必须保留的编译扩展。已收紧为与canonical源码共享实质文件的包身份判定（排除仅初始化/版本文件同名），并对含二进制扩展的真正副本保留原始二进制位置，仅将对应Python实现链接到masked源码、删除隐藏测试与bytecode。修正规则记录
`auditVersion=3`；Pandas已排队 `--new-generation` 归档重做，后续overlay
worker要求其至少v3。其他后续任务自动使用v3；Pandas旧v2不得作为最终准备结果。

包隔离逻辑现提取为同一可测试函数；`tools/benchmark/tests/test_featurebench.py`
的3条回归测试通过，并已纳入默认 `npm run test:benchmark`
目录（该目录实际34项测试全部通过），覆盖同名集成模块保留、真正纯Python/仅mask文件副本重定向，以及二进制hash保持、Python链接、隐藏测试/bytecode删除和后续候选修改可见。测试运行的正是准备时送入容器的函数源码。Pandas真实导入和编译扩展检查在等待最终准备完成后执行，证据将写
`runs/audits/featurebench-pandas-v3-imports.json`。

最终公共core `sha256:20a32f60311a04e2e8a4cdba230c293b04db963eef3d4a4872c8e0ab5b334269`
已经独立环境阶段验收放行。已启动 `20260909-runtime-v3` worker，只接受 `auditVersion>=3`
的规范准备；最终core与environment/launcher/configure/artifacts四个文件hash均写入
`overlays-index.json` 并在每轮核对。前4题旧准备正通过 `cache/featurebench-reprepare-v3.py`
统一重建，进度
`runs/preparation-history/v3-rebuild-index.json`。旧v2结果只保留历史，不混入最终验收。

## 磁盘与下载接续

`runs/audits/featurebench-disk-projection.json`
记录了按实际压缩/展开比和剩余准备代次的容量投影。为保留余量，已仅删除176个已load且不被任何未完成镜像引用的展开tar，共66.78GiB；原始压缩blob逐个重新核对SHA后保留，manifest/config/历史报告/模型产物均未删，没有Docker全局prune。证据
`cache/oci/pruning/1788937486051212757.json`。新下载持共享activity锁，清理需独占；此外保护所有未load
manifest引用层，并逐层持锁。

```bash
# 默认只计算可释放内容并留下报告。
python3 tools/benchmark/pull_image.py --lab-root "$BENCHMARK_LAB_ROOT" --prune-expanded-cache
# 确认外部磁盘容量投影后执行同一安全规则。
python3 tools/benchmark/pull_image.py --lab-root "$BENCHMARK_LAB_ROOT" --prune-expanded-cache --execute-prune
```

Setuptools首次大层下载遇到提前EOF，3.01GB的层只到2.18GB，被大小/SHA门禁拒绝，未导入为有效镜像。现使用相同固定digest和原partial执行Range接续并已成功导入、核对本地镜像内容，证据
`cache/featurebench-setuptools-pull-retry.log`；没有因下载失败更换题目或镜像。

## 每题真实 agent 身份检查

`featurebench.py verify-agent`
是可重建的无模型入口，使用最终runtime的真实launcher初始化，再以UID10001和NoNewPrivileges=1验证：官方可见P2P文件可读、工作区可写、运行时私有site-packages/node_modules不可读、原任务Python及目标包/pytest可用、已跟踪工作树未改变。容器禁网、限制2GiB，与prepare共享独立准备槽锁，评分另用8GiB槽；检查和清理逐项写入
`agent-environment.json`。它是运行条件检查，不能替代官方baseline/gold。

```bash
"$BENCHMARK_LAB_ROOT/cache/featurebench-venv/bin/python" tools/benchmark/featurebench.py verify-agent \
  --lab-root "$BENCHMARK_LAB_ROOT" --task-id <task-id> \
  --prepared-image <final-runtime-image-id> \
  --output "$BENCHMARK_LAB_ROOT/runs/calibration/featurebench/<task-id>/overlays/<new-agent-check-attempt>"
```

当前15题自动队列在
`runs/calibration/featurebench/agent-environments-index.json`，只接受最终core20a32f、v3准备、当前prepared
hash和最终launcher
hash相符的runtime。输出目录每次新建，失败证据保留；当前检查尚在排队，不因root评分通过就宣称agent身份环境可用。

首次源码fetch中断的接续已在新建空仓库实际验证：固定origin、无HEAD且无工作文件时继续获取锁定SHA，既有工作树仍拒绝reset。证据
`runs/audits/featurebench-resume-bootstrap.json` 与
`.log`；该检查复用已锁定依赖与7份数据文件，实际重新获取源码，不冒称第二次全量依赖下载。

资源分槽优化（2026-09-09）：CooperBench全部校准完成后，实测Sympy准备容器cgroup内存峰值255,275,008字节，OOM事件全部为0，证据
`runs/audits/featurebench-prepare-memory-2bc161faa027.json`。后续准备限制2GiB，并与2GiB身份探测共用
`cache/featurebench-preparation.lock`；官方/overlay评分保持清单8GiB并使用原
`featurebench-container.lock`，总容器声明上限10GiB。新准备将实际限制和cgroup峰值写入prepared.json。

切换不终止当前准备：旧8GiB准备与新8GiB评分使用同一原global锁，本来互斥；新2GiB准备/UID直接使用独立preparation锁，总声明上限10GiB。资源计划
`cache/featurebench-resource-plan.json`
保留旧准备进程的PID与精确命令，仅用于恢复清理保护，不控制资源排队。

独立提前审查指出过渡期同task恢复存在跨锁边界：新preparation锁不能独自证明旧global锁下的容器已成孤儿。已在
`archive_preparation`
前核对同task旧PID与完整命令；仍匹配时明确拒绝归档或删容器，其他任务仍可使用双槽。新增真实活子进程回归验证拒绝恢复、原证据保留、不同task/PID命令变化及进程退出后的判定；当前4项FeatureBench回归通过。此防护只用于恢复清理，不把长prepare重新绑定评分槽。

Pandas
v3额外实际检查现已通过：`runs/audits/featurebench-pandas-v3-imports.json`记录canonical源码导入路径、保留的hypothesis集成、44个编译扩展及容器删除。首次导入触发官方editable
Meson/Ninja重建（106步骤），完整构建输出随报告保存；初始两次检查脚本自身导入/输出解析失败分别保留，不记为任务校准失败。最终UID检查另在agent-environments-index中核对，当前packaging与Pandas6类检查均通过；全套仍未完成。

## F1：受mask初始化文件的源码副本修复

独立验收机械确认Pandas v3的 `build/cp311/pandas/__init__.py`
仍与原始完整源码逐字节一致；canonical已mask，但v3把仅有根初始化文件和44个编译扩展的build包误判为同名集成。证据
`runs/audits/featurebench-pandas-generic-copy-v3.json`。Pandas旧prepared已标记ready=false并先归档完整原文件，公共status/freeze已经拒绝其旧runtime/parity/UID结果。此前v3导入和root评分通过仅保留为历史，不能证明源码隐藏正确。

当前v4在官方mask前只采集受mask
generic文件的SHA，不保存原文。真实副本须与该原始SHA匹配，随后将其Python文件指向canonical；保留二进制位置和内容。无关
`hypothesis.extra.pandas`
的不同初始化文件继续保留。新增精确回归覆盖“仅原始init+编译扩展”的副本判定；当前公共测试目录39项全部通过。真实v4检查将同时验证workspace归档中build
init为链接、官方overlay校准、真实UID导入之后副本字节仍等于canonical，以及hypothesis集成和编译扩展仍可用。新进度
`runs/calibration/featurebench/pandas-v4-index.json`，报告目录使用v4新generation。

15题影响审计 `runs/audits/featurebench-generic-mask-impact.json`：只有Pandas与Xarray含根generic
masked路径；Xarray现有v3没有skipped源码候选，其余13题没有该类根路径。嵌套 `cluster/__init__.py`
等路径不属于v3排除的根文件名。已按证据限定只重建Pandas；未受影响v3仍须完成其正常parity和UID检查。

## Setuptools校准失败与替代调查

原题baseline在 `setuptools/tests/config/test_setupcfg.py`
的两个参数化case失败：保留的调用链在当前日期触发已被原题mask删除的
`_should_enforce`，导致NameError和DID NOT WARN；同文件baseline为2 failed/65 passed，gold为67
passed。这是题目mask对P2P的真实副作用。原 `20260909-official-01`
全部评分证据保留，不补回mask内容、不放宽P2P判定、不修改容器日期。固定fast/full仅有这一Setuptools题，lite没有；正在调查未覆盖仓库Hatch的fast
Level1候选，替换需落盘理由和独立验收，所有模型调用仍为0。

## 最新容量复核

旧容量投影低估了flatten镜像大小。实际单题sanitized通常约21–25GiB，剩余9份准备与overlay估计需要额外191–245GiB，另保留20–40GiB单题峰值；scikit-learn较大需逐题复核。已经完成三轮仅展开tar清理，分别66.78、40.44、44.93GiB；第三轮证据
`cache/oci/pruning/1788941196172048674.json`，全部原始压缩blob和manifest保留，展开tar目前为0。主agent依据独立盘点精确回收6个无当前引用的旧sanitized镜像，证据
`runs/audits/retired-featurebench-image-eviction-01.json`，所有历史报告保留。清理后可用空间约202GiB；继续监控flatten峰值，不执行Docker全局prune。

Hatch替换提案已落盘：`pypa__hatch.ff4b4040.test_fmt.782c88a8.lv1`，仍为fast
Level1、15题15仓。原prompt两条工作流是项目/环境配置和插件准备，以及格式命令执行、跨平台参数与Ruff配置生成；通过已解析的环境设置集成。镜像固定
`sha256:70c443280ebe701fe0b6ca24d22c139f3b5c92817a5c1c16c2fc5762b67a4fb1`，提案和替换前完整清单/锁见
`runs/audits/featurebench-selection-replacement-01/`，独立selection预验收待反馈。压缩镜像10.36GB，新增压缩缓存约3.18GB；展开层+官方镜像暂预留45GiB，干净起点与overlay约27GiB，另保留单题峰值30GiB。

旧官方/overlay/UID三个worker启动时读取的是原selection，仍只负责原其余14题，旧Setuptools记录保留失败或等待状态；不能用它们的15题汇总计数判定新清单完成。新Hatch将使用独立队列，新清单以公共
`bench:status`
的实际逐题文件检查为准。结束后将完整归档旧索引、停止只等待retired题的空闲worker，再生成引用当前14题和Hatch新证据的新selection索引；不改写任何历史失败报告。

Hatch selection独立预验收已PASS：原其余14题逐字段未变、15 fast Level1/15仓及原prompt 36,650
UTF-8字节、manifest/config/layers均已复核。现启动独立 `cache/featurebench-hatch-suite.py`，进度
`runs/calibration/featurebench/hatch-replacement-index.json`，attempt
`20260909-hatch-replacement-01`。该worker依次下载固定镜像、只回收已load的展开tar、官方baseline/gold、v4准备、冻结core
overlay
parity、真实UID检查；每步新日志，失败立即保留。环境与校准仍待实际结果，selection通过不等于全阶段通过。

后续prepare在flatten前新增容量门禁：按官方镜像实际未压缩Size的两倍，加20GiB宿主/评分余量，记录
`prepared.diskCapacity`。不足时保存failed
generation并清理容器，待容量恢复后通过新generation安全接续；不会中断已启动的旧准备，也不改变评分内存或测试语义。

Pandas v4现已完成全部真实验证：索引 `runs/calibration/featurebench/pandas-v4-index.json`
的passed=true，runtime
`sha256:10d1dfb2b1a9edf3389a69414ad5df400bf4a191c60ede1b586b7bb341b34d9f`，prepared SHA
`e998901d0fa94960ffd498694bf51cc3b6fa34a0819d9f0d4dd7ec22206983a4`。官方overlay
baseline177.579秒、gold168.602秒均满足校准关系；UID10001+NNP首次导入触发154步Ninja构建，之后build
init字节仍等于masked
canonical，hypothesis集成可用、44个扩展保留，5个原可见测试可读，工作区可写、私有依赖不可读、tracked源码不变，探测容器已删除。此为实施侧验证，等待独立F1复验。

Pydantic原deprecated-fields题的独立只读诊断同样确认真实mask副作用：唯一P2P失败
`tests/test_missing_sentinel.py::test_missing_sentinel_json_schema`，GenerateJsonSchema初始化仍要求被mask删除的computed_field_schema；gold恢复后通过。5份P2P文件均执行、无基础设施缺失；P2P官方50成功/1失败变为51成功/0失败。精确行号与SHA证据
`runs/audits/featurebench-pydantic-p2p-20260909T082820Z/audit.json`。不补回答案、不放宽P2P门禁。

同仓一换一提案 `pydantic__pydantic.e1dcaf9e.test_pipeline.c9b08962.lv1` 已落盘，仍为fast
Level1，复用相同base与已加载镜像、额外官方镜像容量0；旧题归入retired。独立review要求两组各承担实质行为，已修正为pipeline步骤编译/组合与TypeAdapter导出，以及\_apply_constraint/\_check_func约束执行与对应fluent
API；通过约束执行契约集成core schema。完整前后选题与理由在
`runs/audits/featurebench-selection-replacement-02/`，待独立selection预验收；后续独立队列
`cache/featurebench-pydantic-suite.py` 使用新attempt，现未启动模型或候选评分。

Pandas F1独立实测复验已PASS：canonical
8,002字节、旧487字节代码块不存在；44个扩展逐文件hash与历史v3一致；新parity由官方parser确认初始1
ERROR+1887 P2P通过，gold 11通过+1887
P2P通过；真实UID导入重编译后源码副本仍一致。F1可关闭。影响审计已刷新至当前selection SHA
`09cae6a21e3197258e1916a53f3aca6ec1e49c3ea48ff999e8d2b95c7092e592`，包括新Hatch和Pydantic
pipeline，两个旧失败任务保留retired，完整历史快照位于 `runs/audits/generic-mask-impact-history/`。

Pydantic分工metadata按独立review修正后，selection SHA为
`0ee1b5b78e5c61bef0e76d8506f4dd7c85c2bd0b7829e5f03f0a3adb4f588f5d`，原prompt字节不变，影响审计同步当前15题。修正前metadata也已归档，等待selection复验。Hatch官方baseline/gold已通过（12.721/10.518秒），v4准备正在flatten；其已load展开tar定向回收16.46GiB，证据
`cache/oci/pruning/1788942669636748785.json`。当前新清单官方11/15通过。

最新容量口径：`retired-pandas-v3-image-eviction-02.json` 所记录旧Pandas
v3镜像回收已经包含在08:35时约128GiB可用空间中，不能再次加计。剩余实际flatten门槛见
`runs/audits/featurebench-remaining-flatten-capacity.json`，sklearn需76.4GiB、其余约53–54GiB；主agent正在根据独立盘点安排其他无当前引用旧镜像的精确回收。Seaborn官方校准已通过，新清单官方达到12/15。

Pydantic pipeline
selection独立F2复验已PASS：当前0ee1b5选题、原prompt不变、两组实质工作流、其余14题与旧metadata保留均获核对。已启动独立
`cache/featurebench-pydantic-suite.py`，索引
`runs/calibration/featurebench/pydantic-replacement-index.json`，新attempt
`20260909-pydantic-replacement-01`。复用已加载固定镜像；其官方校准/准备/overlay/UID仍分别等待真实结果，模型调用为0。

Pydantic
pipeline官方校准实际失败，独立队列已停止，未创建候选prepare/overlay。baseline13.905秒：test_create_model.py中3个原P2P
JSON schema case因被mask删除的int_schema派发方法失败；gold12.223秒全部通过。报告
`runs/calibration/featurebench/pydantic__pydantic.e1dcaf9e.test_pipeline.c9b08962.lv1/20260909-pydantic-replacement-01/`
完整保留。selection独立PASS只证明选题结构符合要求，不能当成环境校准通过。没有增加Pydantic私有绕过环境变量。

进一步重读handoff：硬要求是15独立任务且覆盖多个仓库，不要求15不同仓库；“每repo一题”是实施初选附加策略。同仓剩余Pydantic候选有单API拆分可信度弱或相同全局schema派发mask风险，full
Optuna候选又含GPU底座和实际轻量helper分工问题。已向主agent提出保留14题、增加已有Sympy仓中独立矩阵求逆任务的15题/14仓方案，复用既有镜像且与现题Puiseux级数功能不同；仍待具体选题审查，未提前计为可用题。

Sympy inverse的15fast任务/14仓selection独立验收已PASS，当前清单SHA
`62c8644aa771a889d61dda4a94c5f5ad973e25949034b3d0fb5c021045b44185`。完整候选调查已补入replacement-03：两Pydantic已执行失败，另三候选明确只作原prompt/静态风险调查，未声称实际全部无效或穷尽。Sympy新官方baseline/gold已通过，索引
`runs/calibration/featurebench/sympy-inverse-index.json`；当前新清单官方14/15通过，仅Sphinx待执行。

Matplotlib真实UID检查发现import触发Meson重新生成失败。详细无网络诊断
`runs/audits/featurebench-matplotlib-uid-681cf048/audit.json`
机械确认UID和同masked起点root均报缺少已删除F2P文件test_backend_registry.py；root
grader在执行前恢复F2P，因此旧root
parity不能揭示这个准备缺陷。诊断曾先在preparation锁排队，已核对尚无容器后取消原host进程并保留记录；主agent授权临时专用2GiB诊断槽，总声明上限12GiB，实际诊断容器已删除。

准备适配现仅移除隐藏测试所在目录Meson安装列表中的精确独立文件名条目，不恢复隐藏测试、不改变可见测试或评分命令。新函数源码与精确回归共用，覆盖相邻可见条目/注释保留、隐藏文件仍不存在、幂等与拒绝尚未隐藏的测试。Matplotlib旧prepared已先完整归档并标ready=false，新
`cache/featurebench-matplotlib-meson-suite.py` 执行修复准备、冻结runtime parity和UID检查，进度
`runs/calibration/featurebench/matplotlib-meson-index.json`。前次因缺归档父目录而未创建worker的host启动失败日志单独保留，不算任务评分失败；实际新队列已启动。

第四组旧Packaging BuildKit按46个具体cache ID回收已完成，证据
`runs/audits/retired-packaging-buildkit-eviction-04.json`；当前磁盘余量已包含该次回收，后续投影不能再次加算。其他历史cache候选尚未执行时也不计入可用空间。

当前15题官方校准已全部通过。新汇总 `runs/calibration/featurebench/current-selection-index.json`
绑定选题SHA与每题当前prepared/runtime/report
SHA；每次只引用当前镜像对应的overlay与UID证据，旧Matplotlib/Pandas的成功或失败不会混入当前门禁。三个已移出题的失败报告单列retiredTasks，旧worker索引仍保持原选择历史，最终会完整归档并停止只等待retired题的空闲worker。锁的calibration.indexPath已指向新汇总。Meson修复后公共测试40项全部通过，后续单纯文档更新不重复运行测试。

最新容量口径：根agent已完成 eviction-05 的62个精确旧BuildKit缓存回收；09:17实测剩余约94.9GiB，已经包含全部五批定向处置，不能再加算旧候选容量。剩余Matplotlib/Sphinx准备继续受2×官方镜像大小+20GiB的flatten容量门禁保护。

### Matplotlib 新归档的实际修复证据（09:21 UTC）

新prepared已ready，`runs/audits/featurebench-matplotlib-meson-repair/audit.json`保存新旧workspace.tar
SHA、当前prepared
SHA及映射；`meson.diff`保存精确行diff。仅排除`.git`后，全部归档条目唯一变化为`lib/matplotlib/tests/meson.build`删除已缺席的`test_backend_registry.py`清单行。隐藏文件在新旧归档均不存在，2456个其他可见测试条目以及5个官方P2P文件的类型、模式、内容或link哈希完全一致。这是实施证据，独立验收另行进行；新runtime官方parity与真实UID检查仍在队列中。

Matplotlib的2456条计数筛选规则已按独立验收反馈补入审计：非目录、非`.git`的tar项，路径含`/tests/`或basename以`test_`开头，排除另行比较的Meson文件；审计JSON保存全部名称，旧审计保存在同目录history。独立验收已确认源码及新prepared范围PASS。新runtime
`3895da9bcc5d…` 官方parity实际通过：baseline 92.722秒、F2P=false/P2P=true；gold
90.229秒、F2P/P2P均true。真实UID检查仍等待最后的Sphinx准备槽。

### sklearn 的 Meson copy 输出修复（09:42 UTC）

最终UID probe首次实际暴露Ninja错误，原官方/root
parity正确不替代此门禁。详细诊断`runs/audits/featurebench-sklearn-uid-15e4c0a3/audit.json`证明UID和root均在`meson --internal copy`把canonical
Python文件复制到指向自身的build
symlink时失败；不是Matplotlib的隐藏测试清单问题。旧prepared已ready=false，原元数据另存preparation-history。

适配仅扫描实际build.ninja的明确Meson
copy规则，将指向相同canonical源码的6个Python输出改为当前已mask内容的普通文件，记录source/destination/SHA；其余symlink、隐藏测试和编译扩展不改。新增回归执行与容器一致的函数源码，验证SameFileError、masked副本、后续agent编辑可复制、幂等性及严格导入路径映射。

临时pilot按实际顺序保留：`featurebench-sklearn-copy-pilot-90756488`在launcher后由root新建输出，因所有权顺序导致UID失败而root97.98秒成功；`featurebench-sklearn-copy-pilot-59f90ff1`由UID物化后真实UID97.32秒/252步导入成功，root复用0.89秒成功，模块路径仍canonical。两容器都删除。最终prepare物化发生于launcher
chown之前；正式UID报告另核对全部6个副本导入后的bytes/原masked
SHA，并记录69.so导入前后的真实重编译变化，不将准备时保留误称为重编译后不变。

代码稳定后公共完整测试43/43通过，Ruff通过。仅最终sklearn新generation尚未启动：实测可用53.93GiB，而flatten门禁需要约76.4GiB，待根agent定向回收缓存。新队列脚本`cache/featurebench-sklearn-meson-copy-suite.py`已落盘。

根agent完成`retired-pydantic-official-image-eviction-06.json`单镜像定向回收后，可用89,462,456,320B（约83.3GiB），已经包含全部六批回收。最终sklearn队列已启动：`runs/calibration/featurebench/sklearn-meson-copy-index.json`，attempt
`20260909-sklearn-meson-copy-01`，原官方PASS沿用，顺序执行准备、固定runtime、官方parity、UID。

### sklearn 最终准备的实际归档证据（10:01 UTC）

`runs/audits/featurebench-sklearn-meson-copy-repair/audit.json`保存实际新旧archive和prepared
SHA。排除仅`.git`后，唯一6处变化为Meson实际copy输出从symlink变为与masked canonical
SHA/bytes一致的普通文件；其他全部条目不变。69个编译扩展的准备前后SHA逐个相同，388个非目录可见test条目（路径含`/tests/`或basename以`test_`开头）与5个原P2P文件均相同，隐藏F2P仍不存在。最终runtime为`67e3fa06916b…`，当前正执行官方parity，随后真实UID会另外记录合法重编译后的二进制变化。

## 最终实施包（2026-09-09 10:10 UTC）

当前15题全部五类门禁均通过：official、prepared、runtime、overlay、UID。权威结果为`runs/calibration/featurebench/current-selection-index.json`；`runs/audits/featurebench-final-package.json`列出当前manifest/lock/index/源码审计/逐题报告的确切SHA与43/43公共测试证据。三条退选题官方失败及所有被替代generation完整保留，不能把旧失败改记为通过。独立终验及正式冻结由主agent执行；FeatureBench实施层不再修改清单与锁。

`runs/audits/featurebench-final-status-transition/transition.json`记录从`62c8644…`至`ddd1afd…`的16项字段变化：仅selectionStatus及15项calibrationStatus。目录保存前后完整manifest/lock，任务ID、原prompt
SHA、环境固定项和分工逐字段保持一致。最终FeatureBench锁SHA为`537f44995eb84c41a9e5aa951a6fca581955a97660be7939d009e11585d86059`。`featurebench-generic-mask-impact.json`已与最终清单SHA及最新15题prepared
SHA对齐，并保留3个退休任务；根generic mask仍只涉及Pandas/Xarray。

sklearn最终runtime
`67e3fa06916b…`官方parity：baseline127.953秒、F2P=false/P2P=true；gold122.792秒、F2P/P2P均true。真实UID8项检查全部通过，导入101.293秒，模块路径仍canonical，全部6个物化源码副本导入后仍满足原masked
SHA/bytes相同。69个编译扩展在准备归档对照中逐SHA相同；独立的UID导入前后快照实测也是69→69、changed=0、added=0、removed=0，不以准备阶段证据代替此后观测。容器已清理。

两个旧worker按真实宿主PID、启动ticks、精确argv、无child及仅等待退休题核对后安全TERM结束：`runs/audits/featurebench-retired-worker-shutdown/audit.json`。原索引完整快照，历史结果未改。曾在默认受限/proc中得到错误缺席读数，未据此操作或写死亡记录；最终生命周期判定使用require_escalated宿主。
