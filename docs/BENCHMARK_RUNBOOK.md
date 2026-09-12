# FeatureBench / CooperBench 本地实验运行手册

了解实验结果请先看[阅读导航](benchmark/README.md)。本手册用于查操作和数据路径，不必从头阅读。

## 2026-09-11 当前状态：补跑也已complete

原30项已完成，用户追加的四项单次补跑也于12:56:55正常收尾。当前活动批次为
`fault-supplement-20260911-001`：003/005/016模型completed，030仍OOM失败并有参考补丁实际应用，四项均保存trace/分析并清理，原30项结果不变。只读[补跑结果](benchmark/FAULT_SUPPLEMENT_RESULTS.md)
和[最终验收](benchmark/FAULT_SUPPLEMENT_FINAL_REVIEW.md)，无需start/resume或再次补跑。

```bash
python3 tools/benchmark/service.py status
```

补跑数据单列，不用于替换原失败。下方准备/启动/停止/接续命令都是历史或未来明确新任务的参考。

## 历史：2026-09-11 四项故障补跑启动

原30项已complete且结果不变；用户另授权003/005/016/030各追加一次，当前活动批次为
`fault-supplement-20260911-001`，四项编号均以`-02`结尾，独立runner已启动。原deadline任务与009不重复；仅030提高内存到3840MiB并单列条件变化。
[计划/新OOM证据](benchmark/FAULT_SUPPLEMENT.md)、[独立验收](benchmark/FAULT_SUPPLEMENT_REVIEW.md)。

```bash
# 查看当前4项补跑，不依赖npm
python3 tools/benchmark/service.py status

# 需要时安全停止或接续同一补跑批次
python3 tools/benchmark/service.py stop --run-id fault-supplement-20260911-001
python3 tools/benchmark/service.py resume --run-id fault-supplement-20260911-001
```

补跑complete或blocked后再调用Codex分析与独立验收，不持续守候，不自动重试至成功。下方原30项完成说明继续有效；补跑与原30项分开统计，不覆盖原结果。

更新日期：2026-09-10。**本轮30项已经complete，无需重新start/resume。**
先读[完成概览](benchmark/FINAL_BATCH_SUMMARY.md)和[独立终验](benchmark/FINAL_BATCH_REVIEW.md)，再按其中路径读取批次摘要、异常索引和已有分析。完成时间为北京时间19:59:26，runner已正常退出；模型异常、用户中断、030上游读取与未评分等边界均保留，不能把complete理解成全部任务正确。

```bash
# 只读查看当前活动批次，自动选择当前活动批次，不依赖npm
python3 tools/benchmark/service.py status
```

最终批次为 `acceptance-30-001-behavior-v3`，结果和trace在仓库外
`../benchmark-lab/runs/`。终态审计与30项CSV概览在
`runs/audits/final-30-completion-1789042674304/`。下方启动/停止/接续/校准命令保留作历史或未来显式新任务的操作参考，本次完成后不要自动执行。

## 历史：v3接续入口

016因观察读取超时结束后，runner容错修改使用新的 `acceptance-30-001-behavior-v3`
批次，继承原001–016证据，仅调度017–030。原v2保留blocked历史，不应继续用其状态判断当前实验。阶段进展和实际启动状态见[暂停交接](BENCHMARK_PAUSE_HANDOFF.md)顶部及
[超时恢复记录](benchmark/OBSERVATION_TIMEOUT_V3.md)。旧环境准备、评分策略和模型预算继续复用。

```bash
# 查看当前活动批次：不依赖npm，不需要填写版本号
python3 tools/benchmark/service.py status

# v3的启动、停止和接续必须明确指定批次
python3 tools/benchmark/service.py start --run-id acceptance-30-001-behavior-v3
python3 tools/benchmark/service.py stop --run-id acceptance-30-001-behavior-v3
python3 tools/benchmark/service.py resume --run-id acceptance-30-001-behavior-v3
```

只读请求最多三次尝试，重试不重新提交模型，且沿用原模型截止和停止请求。
`attempts/*/api-requests.jsonl`与`attempt.json.readDiagnostics`保留恢复过的读取故障；其计数也包括证据收尾期间的读取，不直接当作模型工具次数或纯执行阶段耗时。
`exceptions.json`列出这些读取异常，即使重试成功也不会抹除记录；是否阻断以当前`progress.status`为准。

下文v2命令和状态作为前一版本的历史记录，当前操作优先使用以上入口。

## 历史：v2独立运行入口（2026-09-10 实现）

按[最新接续安排](BENCHMARK_PAUSE_HANDOFF.md)执行：完成修改及一次独立阶段验收，随后由systemd 用户服务运行剩余任务。Codex在启动交接完成后结束当前轮次；整批完成或出现阻断时，再读取摘要和异常索引、按需分析，并由独立sub-agent做阶段验收。不逐题审阅或持续派agent守候。

原批次 `acceptance-30-001` 维持
`interrupted`，001–005原始状态、评分、产物、trace及关机中断记录只读保留。新配置
`experiments/behavior-30-v2.json` 只改变suite版本和
`officialScoring=false`，沿用全部30题冻结环境证据，不重新准备、下载、校准或构建镜像。新接续批次
`acceptance-30-001-behavior-v2` 保留30项总计划及原编号，用带SHA的引用继承001–005，从006 Sympy
Puiseux开始调度余下25项。005仍是用户中断，不因接续重跑或改作完整预算下失败。

当前独立服务已启动，006已提交；日常只需状态命令，出现需要时再停止或接续。以下启动/分配命令作为完整入口保留，正在运行时不要重复执行。全部命令在仓库根目录的独立宿主终端执行。首次分配只记录新版本，不提交模型；已分配且runner停止时会核验同一记录后返回，不能创建第二份不同来源的接续。当前实际分配/验收状态见[暂停交接](BENCHMARK_PAUSE_HANDOFF.md)顶部。

以下Python入口不依赖npm；状态查看只读取记录和systemd状态。

```bash
export PATH="$PWD/.cache/opensandbox/node/bin:$PATH"
export BENCHMARK_LAB_ROOT="$(dirname "$PWD")/benchmark-lab"

python3 tools/benchmark/cli.py prepare-continuation --from-run-id acceptance-30-001 \
  --run-id acceptance-30-001-behavior-v2 --config experiments/behavior-30-v2.json

# 恢复原宿主模型代理 127.0.0.1:7890 后，启动独立服务：
python3 tools/benchmark/service.py start --run-id acceptance-30-001-behavior-v2

# 查看批次进度与systemd服务状态；不会重新分析trace或调用模型：
python3 tools/benchmark/service.py status --run-id acceptance-30-001-behavior-v2

# 安全停止：落盘请求，当前attempt取消、采集、导出并清理；等待状态变为interrupted。
python3 tools/benchmark/service.py stop --run-id acceptance-30-001-behavior-v2

# 排除阻断或停止后，仍使用相同新批次接续：
python3 tools/benchmark/service.py resume --run-id acceptance-30-001-behavior-v2
```

`bench:start` / `bench:service-resume` 提交给
`systemd --user`，终端命令立即返回；runner、控制平面和新启动的Docker bridge relay归属独立service
cgroup，日志不依赖终端stdout。worker检查原7890代理，复用或恢复已有
`oi-opensandbox-server`，按需启动17890
relay，自动启动本批控制平面。既有relay只复用，自己启动的relay在runner退出时收尾。不需要另开8788控制平面或让Codex工具后台进程承担长时间运行。

本机无模型探针已验证启动命令退出后service继续落盘。系统仍须开机且避免休眠；当前
`Linger=no`，用户服务独立于Codex会话，但注销全部系统登录会话不在持续运行保证内。不会自动跨关机重启实验，重启后恢复原代理并使用上述接续命令。模型/工作区已丢失时保留中断尝试，不能恢复已关闭的模型上下文。没有自动重试模型直到成功。

停止命令只写 `stop-request.json`，允许当前证据收尾完成；不要用删除锁、全局清理或 `systemctl stop`
代替安全停止。状态里的 `MainPID=0` 表示runner已退出； `active/exited`
是systemd保留终态供检查，不表示模型仍在运行。强制杀进程后的批次进度可能停在上次落盘位置，必须同时核对服务状态、异常和现存资源后再接续。原两把内核锁继续限制并发。

结果均在 `$BENCHMARK_LAB_ROOT/runs/acceptance-30-001-behavior-v2/`：

- `progress.json`：简要批次状态、阶段计数、当前/下一attempt、最近观察时间、评分分类和阻断原因；观察阶段随既有checkpoint周期更新，setup/收尾期间以attempt阶段及服务日志为准。
- `exceptions.json`：异常索引，包含attempt、维度和证据路径；跳过评分不作为异常。
- `report.md` /
  `report.json`：完整30项计划，区分历史5项评分与新25项按配置未评分；不会把未评分算作答错。
- `runner-service.json`：当前unit、launchId和日志路径；`launches/<launchId>/runner.log`、
  `worker.json`、`exit.json`及失败时的`error.json`保存每次独立启动、进程归属和退出记录。
- `source-evidence.json`：旧批次每个原始文件的SHA清单；`run.json`记录来源、原冻结配置hash、继承/剩余编号及当前实现快照。接续会核验原证据与当前源码，拒绝悄悄换实现。
- 每个新attempt照常保存父子session、不可变patch、完整trace和逐题分析；整批自动运行
  `trace-batch-*/analysis/`。既有模型用量/成本、时间及采样资源观测保留；缺测不填零冒充测得。

需要详细日志时，先用 `bench:service-status` 取得
`launch.logPath`，再按需读取；日常无需盯日志。阻断错误会将批次标为`blocked`并停止继续调度；模型解题失败、deadline或协议问题仍如实保留并推进。再次出现观察GET超时会停止批次、保留收尾证据，供下次Codex调查。

`officialScoring` 是布尔配置项，缺省为false。按配置跳过时，结果为
`benchmarkCorrectness.status=not_scored`、`reason=disabled_by_config`，不创建scoring
generation。选择官方评分须在新的冻结配置中显式设true；评分失败保持独立状态，旧评分产物不能被跳过逻辑替换。CooperBench原始child补丁和parent集成产物链仍检查；官方评分引用在跳过时标为not_scored。协议validator
v4继承原行为检查，机器passed仍只表示自动证据检查通过。

旧配置/旧批次下文命令保留作历史参考；不能直接resume旧
`acceptance-30-001`，实现会拒绝无版本记录的旧runner接续。全30题校准已有独立PASS，本次只做必要代码和独立运行验证。

## 外部目录和配置

```text
benchmark-lab/
  sources/FeatureBench/              # 固定上游 Git checkout
  sources/CooperBench/
  datasets/                         # 完整数据、gold和评分测试，仅评分侧可见
  cache/                            # OCI层、虚拟环境、离线wheelhouse、runtime构建
  task-workspaces/<taskId>/
    prepared.json                   # 清理后image、单commit起点、原prompt引用
    runtime-overlay/runtime.json    # 实际runtime image ID及构建来源hash
  runs/calibration/<benchmark>/     # 原始和参考解评分，包括失败与重试历史
  runs/<runId>/                     # 持久化模型批次、attempt、产物和trace
```

仓库中的 `experiments/featurebench-tasks.json` 与 `cooperbench-tasks.json` 保存15+15题。各自
`*-lock.json` 保存源码、数据和环境来源，CooperBench inventory
hash 的算法为按键排序、无额外空格的规范 JSON SHA256；具体文件 hash 另存 inventory 中。

`experiments/pilot-30.json` 是第一版验收配置：DeepSeek
Flash、一个parent和两个直接children、单题并发、每题一次尝试。执行截止、setup截止与sandbox
TTL分别配置。CPU和内存包含三个模型容器的容量；评分在模型容器采集和移除后进行。本实验`runtimeMaxRestarts=0`：OpenCode/桥接进程失败时停止sandbox并记基础设施失败，不在同一attempt内隐式重启。产品默认重启策略保持不变。当前只有墙钟预算，OpenInspect尚不实施严格token/费用上限，因此不能把本配置描述成固定token预算对照实验。正式多轮批次需依据试跑成本另建配置，当前不会自动启动90次实验。

密钥从已有 `.cache/opensandbox/sandbox-env.json` 和 `connection.json`
读取，不写入清单或prompt。每个批次的独立控制平面使用
`runs/<runId>/control-plane/`，默认端口8788；原有8787开发实例不受影响。批次私有配置和原始日志不可直接公开。服务使用新建本地D1和签名密钥，无云部署。

## 准备和无模型校准

本机已有下载和固定版本。新机器先配置本地 OpenSandbox（见其 README），并让下面的`python3`指向Python
3.13.5；FeatureBench
bootstrap会按依赖锁严格检查此版本，再创建外部评分venv。之后使用仓库内入口获取固定材料：

```bash
python3 --version  # 必须为Python 3.13.5
python3 tools/benchmark/cooperbench.py bootstrap --lab-root "$BENCHMARK_LAB_ROOT"
python3 tools/benchmark/featurebench.py bootstrap --lab-root "$BENCHMARK_LAB_ROOT"
python3 tools/benchmark/featurebench.py pull-images --lab-root "$BENCHMARK_LAB_ROOT"
```

下载和安装步骤有固定版本/hash，并支持复用已验证的外部缓存。随后构建与校准：

```bash
# runtime relocation所用工具，保留固定版本wheel及hash
python3 -m pip download --no-deps --dest "$BENCHMARK_LAB_ROOT/cache/runtime-tools" patchelf==0.17.2.4
npm run build -w @open-inspect/shared
npm run bench:build-runtime

# 支持 --task-id 精确处理一题；默认全部题目
npm run bench:calibrate
npm run bench:prepare
npm run bench:calibrate -- --overlay
npm run bench:verify-agent
npm run bench:status
```

FeatureBench CLI使用外部 `cache/featurebench-venv/bin/python`，依赖版本见其锁文件。CooperBench
CLI与公共runner使用Python标准库；评分器的传输层调用Docker，保留固定上游评分函数。所有评分日志使用外部cwd/output。准备或校准失败必须查看逐题报告，不把“运行过脚本”算通过。

本次实施还运行逐题worker。FeatureBench当前选题证据汇总为`runs/calibration/featurebench/current-selection-index.json`，包含清单SHA、每题当前镜像及报告SHA和三份退选失败。实时状态以`bench:status`重新检查为准；原`index.json`、`overlays-index.json`和`agent-environments-index.json`中的队列使用最初清单，其汇总计数不能代表替换后的15题。替换或修复队列另有`hatch-replacement-index.json`、`sympy-inverse-index.json`、`pandas-v4-index.json`、`matplotlib-meson-index.json`和`sklearn-meson-copy-index.json`，保留原失败代际。

CooperBench最终代际在`runs/calibration/cooperbench/final-20a32f60-20260909T065404Z/`，其中`build.json`、`verification.json`和`active.json`分别记录构建、完整验证和当前题目；单题根目录的`calibration.json`是兼容别名，冻结使用不可变attempt报告，不能据别名判断worker是否存活。可以用下列只读命令查看当前相关进程，并将脚本路径与索引代际对应：

```bash
ps -eo pid,comm,lstart,etime,args | rg '^[[:space:]]*[0-9]+[[:space:]]+python[0-9.]*[[:space:]]' | rg 'featurebench[^[:space:]]*\.py|cooperbench/final-[^/]+/worker\.py'
```

进程仍在工作时观察索引和日志，避免重复校准同题；PID存在本身不证明是原worker，需核对命令路径和启动时间。本机受限执行环境的进程视图可能看不到宿主worker，PID缺席时应在宿主执行环境复核，不能据此重复启动。worker确已停止时，按状态中缺失的步骤用仓库入口接续，例如：

```bash
npm run bench:calibrate -- --task-id <task-id>           # 官方校准未完成
npm run bench:prepare -- --task-id <task-id>             # prepared/runtime未完成
npm run bench:calibrate -- --task-id <task-id> --overlay  # 当前精确镜像未完成重放
npm run bench:verify-agent -- --task-id <task-id>         # 当前镜像的实际用户环境未验证
```

失败历史不删除；更换已完成的prepared初始化规则时，先按对应adapter的`prepare --help`创建新准备generation，再重建runtime并重新校准。

Docker daemon直接拉取不可用时，使用公共代理下载器，复用调用者HTTP代理而不修改daemon全局配置：

```bash
python3 tools/benchmark/pull_image.py --help
```

下载器选择linux/amd64、固定manifest、逐层验证压缩/解压hash，缓存可接续。FeatureBench候选15镜像的唯一压缩层实测约90GB，`fast`指测试时间而非镜像下载大小；下载与解压需要足够磁盘和时间。

压缩下载量不能当作总磁盘需求：按Docker独占占用口径，本机六份旧FeatureBench准备镜像每份约19–23GiB；官方镜像、展开缓存和新旧准备版本会同时占用空间。容量盘点见外部`runs/audits/disk-capacity-20260909T0800.md`，逐题准备还需预留导入和容器写入峰值。展开层缓存可用`pull_image.py --prune-expanded-cache`先只读计算，再以`--execute-prune`按同一引用规则回收；原压缩层与报告保留。旧准备镜像仅在核对已被替代、无当前任务或容器引用后按精确ID处理，记录见`runs/audits/retired-featurebench-image-eviction-01.json`；不能按镜像总数或全局prune清理。

FeatureBench使用官方mask和测试可见性规则；数据patch是移除功能的补丁，gold需反向转换。空prediction会被官方harness提前拒绝，因此baseline校准使用无功能影响的新增sentinel文件强制进入测试链路，报告明确标记。CooperBench逐个校准单feature
gold，并用`combined.patch`检验组合oracle；两个单feature
gold不保证可合并。评分容器使用锁定的离线wheelhouse满足官方runner的重复安装需求，网络依赖安装失败单独记为环境问题。

agent环境清除原始解副本、完整Git历史和评分专有内容，保留原本可见测试。runtime解释器和动态库位于
`/opt/oi-runtime/`，任务Python/Node继续使用官方环境。模型工具进程使用独立UID10001及no_new_privs；运行时Python
site-packages及npm目录仅supervisor可读，避免带入未mask的目标实现。模型可读写任务工作区，原测试和任务依赖仍可见，产物工具以`-S`使用独立Python标准库。每个sandbox从相同清理后镜像启动，任务位置见
`/opt/oi-benchmark/task.json`，不需要在上游仓库安装GitHub App。

下面只做正常API无模型启动、实际工具进程身份/可见性检查、模型列表认证、采集和清理，不检验模型分工，也不请求模型生成：

```bash
python3 tools/benchmark/warm_check.py --task-id cooperbench-go-chi-26-1-2 --check-credentials
# 可选：无模型受控进程退出，验证禁重启、停止容器产物回收与清理
python3 tools/benchmark/warm_check.py --task-id cooperbench-go-chi-26-1-2 --verify-crash-stop
```

全部30题的官方baseline/gold、runtime镜像重放校准和实际用户环境检查通过、独立验收完成后才能冻结。`bench:verify-agent`只检查任务工具/可见测试/权限及清理，不提交模型prompt；其结果必须关联当前精确镜像，状态计数为`agentEnvironmentPassed`：

```bash
npm run bench:freeze
```

生成
`experiments/pilot-30.lock.json`，锁定清单、附录、配置、两份源码/数据/评分器版本锁以及每题准备/镜像和校准证据hash。启动和接续都会拒绝这些锁定文件的变化，批次`benchmark-locks/`保留两份版本锁副本。其他配置按其`suite`生成`experiments/<suite>.lock.json`，保留旧套件的锁和批次；`--config`选择配置，`--suite`仅作可选的一致性断言。冻结失败的具体缺项在
`runs/freeze-preflight.json`。环境缺陷导致替换题须保留原题失败证据并重新验收；冻结后不得根据模型解题失败更换题目。既有冻结版本不覆盖，需要新实验版本时另存配置和清单，并使用新的`suite`名称；后续命令通过`--config`选择该配置。

## 模型试跑、单轮验收与接续

### 检查当前runner

先执行`bench:status`刷新准备快照，从`runs/active.json`读取run-id。批次的`run.json`
保存计划，`attempts/*/attempt.json`保存当前阶段、session树和最后观察时间，`report.json`
是最近汇总；`run.json`中的`allocated`也可能已有runner在执行，不能只凭这个字段重启。下面的只读命令应在Linux宿主进程视图中运行，关联两把锁的实际设备/inode、持锁PID及启动身份：

```bash
python3 - <<'PY'
import json, os
from pathlib import Path
lab = Path(os.environ["BENCHMARK_LAB_ROOT"]).resolve()
active = json.loads((lab / "runs/active.json").read_text())
run = lab / "runs" / active["runId"]
print("active batch:", run)
print("batch status:", json.loads((run / "run.json").read_text())["status"])
locks = Path("/proc/locks").read_text().splitlines()
for path in [lab / "runs/coordinator.lock", run / "batch.lock"]:
    if not path.exists():
        print(path, "not created")
        continue
    record = json.loads(path.read_text())
    stat = path.stat()
    identity = f"{os.major(stat.st_dev):02x}:{os.minor(stat.st_dev):02x}:{stat.st_ino}"
    print(path, record, "kernel locks:", [row for row in locks if identity in row.split()])
    proc = Path("/proc") / str(int(record["pid"]))
    try:
        print("startTicks:", proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19])
        print("command:", proc.joinpath("cmdline").read_bytes().replace(b"\0", b" ").decode())
        print("cwd:", proc.joinpath("cwd").resolve(strict=True))
    except FileNotFoundError:
        print("PID absent in this process view; verify the host view before resuming")
PY
```

实际内核锁仍由对应`tools/benchmark/cli.py run`或`resume`进程持有时，继续观察，不能启动第二个runner。锁文件里的旧PID可能被复用；须同时核对命令中的run-id、cwd、启动身份和内核持锁关系。受限视图下PID或`/proc/locks`记录缺席不能证明退出；需切换宿主视图复核。只有宿主确认原runner退出且两锁释放后才接续。不要删除`active.json`、锁文件或提交意图来绕过检查；内核锁会随进程退出释放，残留锁文件本身不是阻塞。

当前30题单轮的观察及接续入口是：

```bash
npm run bench:report -- --run-id acceptance-30-001
# 仅在上述宿主退出/锁释放检查通过后：
# npm run bench:resume -- --run-id acceptance-30-001
```

### 启动试跑和单轮验收

完整校准之后先各benchmark一题真实parent/child试跑，再30题低并发单轮验收：

```bash
npm run bench:run -- --run-id pilot-pair-001 \
  --task-id pypa__packaging.013f3b03.test_metadata.e00b5801.lv1 \
  --task-id cooperbench-samuelcolvin-dirty-equals-43-2-3

npm run bench:report -- --run-id pilot-pair-001
# 两题的接入、协议和证据验收后
npm run bench:run -- --run-id acceptance-30-001
```

每次run-id必须唯一，先落盘再POST。内核文件锁禁止两个runner同时控制实验；有未完成批次时先检查原runner，仍运行则观察，退出后接续，不能无条件新建同批任务。runner创建独立CP并通过正常API提交，父模型实际调用`spawn-child`。父子间通过模型可调用的`oi-bench publish/list/fetch`传送不可变patch；授权使用每session的正常sandbox
token，parent只可读取自己及直接child的产物。发布与宿主checkpoint分开记录，避免覆盖原始child结果。

```bash
npm run bench:resume -- --run-id acceptance-30-001
npm run bench:report -- --run-id acceptance-30-001
```

正常SIGINT/SIGTERM执行取消、代码采集、完整树导出和清理。重启runner时使用原run-id，重新挂接仍存活的session树。模型sandbox已丢失时不能恢复workspace/模型上下文，原attempt记中断；新的尝试必须另建并保留旧结果。当前不自动重试模型直到成功。

API创建或prompt提交超时后可能已经生效，`create_intent`/`prompt_intent`状态会保持待对账。resume只按唯一标题或原prompt查询，不重复POST；对账仍不明确时停止推进并保留状态，不手工删除意图文件。评分中断不重跑模型：未完成的scoring
generation保留，接续只创建新的评分generation。代码最终采集失败会保留容器并标记cleanup
pending；需在TTL前接续，失去容器的证据缺口必须报告。

模型结束判定使用完整session树，不能只看parent回复。取消API是异步的；清理会先停止已验证归属本批次的容器，再从停止的workspace采集最终patch，停止或采集失败则保留容器待接续。清理反复发现本批次后续出现的children，按确切session/
container/native OpenSandbox
ID删除，在有界窗口确认收敛；不得使用全局`docker prune`或清理其他开发容器。

## 找到结果与trace

每个batch有`run.json`、配置/清单/冻结副本、`report.json`、`report.md`，以及适配源码快照和已跟踪工作树补丁。结果保存CP模型设置、runtime
prompt.start的实际分发设置、每session证据覆盖缺口，不能把配置记录单独当作模型服务执行证明。每个
`attempts/<attemptId>/` 包含：

- `attempt.json`：task、attempt、session树、阶段、执行截止、独立结果维度。
- `prompt.original.*.txt`、`prompt.appendix.txt`、`prompt.submitted.txt`及hash；提交前和接续时验证字节。
- `artifacts/<sessionId>/<sha256>.patch`、`published.json`和`checkpoint.json`，含新增/删除/权限/二进制。
- `artifact-coverage.json`：每个session最终采集状态及可用版本；容器已丢失、仅有周期checkpoint时标为partial，清理完成不代表产物完整。
- `protocol.json`：带validatorVersion的自动协议证据。发布、下载、交付、最终回复和Cooper评分引用按同一child补丁SHA关联；parent发布须匹配最终checkpoint。
- `containers.json`、分页messages、`observations-*`原始collector日志、`capture-errors.jsonl`与`cleanup.json`。
- `scoring-*`官方结果/日志及独立完成记录；CooperBench分别保存原始child合并与parent集成评分。
- `trace-*`完整树导出及hash、`analysis-*`分析；重导出保留此前generation。

离线分析失败独立记录在`analysis.status`，保留已导出的trace路径；不会为分析失败重跑模型。`bench:report`只汇总现有结果，不重新计算trace分析。手动重算时明确指定同一profile及外部输出/cache，使用新的输出目录保留旧结果：

```bash
# TRACE_PATH取attempt.json中trace.path；ANALYSIS_OUT使用新的外部目录
npm run trace:analyze -- "$TRACE_PATH" --profile block-d0-v1 --out "$ANALYSIS_OUT"
# COLLECTION_PATH取既有trace-batch-<generation>/collection，不把多次导出算成多次attempt
npm run trace:batch -- "$COLLECTION_PATH" --profile block-d0-v1 \
  --out "$BATCH_ANALYSIS_OUT" --cache "$BENCHMARK_LAB_ROOT/cache/trace-analysis"
```

例如`ANALYSIS_OUT="$BENCHMARK_LAB_ROOT/runs/<run-id>/attempts/<attempt-id>/analysis-manual-001"`、`BATCH_ANALYSIS_OUT="$BENCHMARK_LAB_ROOT/runs/<run-id>/trace-batch-manual-001"`。手动分析CLI只写指定目录，不回写`attempt.json`或批次状态。原始trace导出失败会停留在已采集阶段，`bench:resume`重新导出现存session证据后再推进；批次末尾的批量分析失败也可用resume继续。上述接续均不重新提交已执行的模型prompt。

trace附加数据过滤到本attempt的session/container，另保留标注为共享的宿主/服务器测量。原始collector目录仍是私有宿主观测，可能包含同机其他OpenInspect活动，不应直接共享。
`traceProfile`传给已有分析器。批次完成后自动生成`trace-batch-*/analysis/`：每个attempt只取最终trace，不会把接续产生的多份导出当成额外实验次数。输入清单与cache均在外部目录，失败attempt仍在benchmark汇总分母。

模型执行、child协议、benchmark正确性、trace完整性、基础设施故障和清理分开报告。所有计划attempt均进入汇总分母，未开始项也明确显示；不取best
attempt掩盖失败。消息区间重叠不代表shell同时执行，采样内存峰值不是精确lifetime峰值，精确重复操作也不能直接解释为可消除的语义冗余。

协议`failed`表示存在已证实的自动检查问题；`review_required`表示自动检查通过，但改写的child需求需要独立语义复核。未逐字复制本身不能证明需求丢失，也不能自动当作语义完整。`passed`仅表示自动检查通过；实质分工、集成/验证质量及禁取上游等语义限制仍要结合轨迹独立验收。人工结论保存在阶段验收报告中，不抹掉机械检查结果。已完成批次的报告修正须先归档旧报告/状态及SHA，另存validator来源和修正审计，不能重跑模型或评分来替换失败。

首批真实证据在`runs/pilot-pair-001/`：packaging超时且F2P未通过、P2P通过；dirty-equals完成模型与产物链，原child
naive合并冲突，固定上游随后尝试lead-only
fallback但仍未同时通过，parent独立集成也有一个Email用例失败。两题都已评分、完整导出/分析并清理。原协议判定的P1/P2修正见`runs/audits/pilot-protocol-validator-v3-1788953572795/`（此前v1/v2报告及审计保留）及[试跑独立验收](benchmark/PILOT_REVIEW.md)。恢复技术验证单独使用`recovery-dirty-001`批次，不混入这两个自然试跑或后续30题的分母；已完成模型、评分、trace和清理并独立终验PASS。恢复仅中断runner，原沙箱、提交和截止时间保持；详细审计位于`runs/audits/live-runner-recovery-recovery-dirty-001-1788953877483-83507069/`。三份产物齐全，需求人工语义复核通过，机器review_required保留；官方child-pair与parent集成评分仍失败。

CooperBench结果标为OpenInspect父子协议：parent可见两feature、可协调和改代码、消耗额外模型预算；
`official_child_patches`与`openinspect_parent_integration`是两个不同结果，不混为官方peer协作分数。

## 开发验证

```bash
# 使用已安装pytest的外部venv，或先安装仓库常规测试依赖
"$BENCHMARK_LAB_ROOT/cache/adapter-venv/bin/python" -m pytest tools/benchmark/tests -q
npm test -w @open-inspect/control-plane -- src/sandbox/providers/opensandbox-provider.test.ts
npm run test:integration -w @open-inspect/control-plane -- test/integration/spawn-children.test.ts
npm run test:trace-export
npm run test:trace-analysis
```

loopback HTTP / Docker /
workerd测试需要宿主相应权限。独立验收agent只给反馈，不负责修复。修复后由实施agent重测并请求复验，实际记录见
[阶段验收](benchmark/STAGE_REVIEWS.md)。
