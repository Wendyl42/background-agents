# 协作公开数据包发布前独立验收

日期：2026-09-11。候选目录名：`benchmark-collaboration-20260911`。本报告仅使用公开包相对路径，不记录凭据值或原机器的真实home路径。

**最终候选PASS：在下述已核验范围内，未发现阻断公开发布的凭据残留、身份损坏或必要分析素材缺失。**
本验收针对未压缩候选；压缩资产的上传完整性及远端摘要由发布步骤另行核对。验收者没有修改候选、原实验数据、运行模型或发布任何内容。

| 最终候选锚点         | 已核验值                                                           |
| -------------------- | ------------------------------------------------------------------ |
| MANIFEST.json SHA256 | `555a7364b428c3c7cc985e8efaa4f1e688cbc55f3c66eb8cdcdde7ec2f54613a` |
| 清单所列文件         | 11,239份，另有MANIFEST自身                                         |
| 清单所列逻辑字节     | 4,673,630,173                                                      |
| 主/补cohort          | 原30项与独立补跑4项，分别记录                                      |

## 公开安全核验

前期审阅发现的以下问题已在最终候选修正，并重新独立检查：

- 私有配置遗漏：17个 `BROWSER_AUTH_SECRET` 曾未被规则覆盖。最终排除
  `control-plane-env.json`、私有连接/env文件及seed-secrets等运行配置，并用已知真实值清洗其他副本。
- 运行时凭据遗漏：补跑030的一次真实环境输出包含
  `SANDBOX_AUTH_TOKEN`，此前未进入全局配置值集合。最终已清除该值及其raw/normalized/批量collection等副本；未把
  `token:<messageId>` 当作凭据。
- Git归档扫描缺口：所有nested TAR无条件移除Git内部文件，包括opaque pack，未再依赖只扫描loose对象。
- 容器绝对链接：原构建目录中的已知内部绝对链接改为归档内相对链接；最终归档不含绝对或根外链接。
- 误脱敏：PEM delimiter操作代码、普通sklearn
  CSS名称不再被宽泛模式误改；原非Git源码与最终成员清单重新对比。

独立扫描在内存中收集并检查105个当前/历史私有配置值（含上述17个browser
secret），另加入从原环境输出确认的1个运行时token，共106个私有值，包含原字节和JSON转义形式。对最终公开文件、所有保留TAR成员内容和头部元数据，及高置信token/有效PEM形态进行检查，残留发现为0。原home/project前缀检查也为0残留。扫描没有输出匹配值。

另独立用既有PyArrow解码3份上游Parquet，共330行；对解码内容使用相同106值和模式扫描，发现为0。47份去重后的公开normalized
trace中，也不再存在未脱敏的真实运行时认证赋值。这是对已知本地凭据、明确运行时凭据及高置信模式的核验，不承诺识别每一种未知凭据形态。

## 必要数据与身份保真

COHORTS的原30项与补充4项逐项和本机原记录对应：

- 全部2,776份attempt文件保留，包括119份prompt文本素材、431份patch，以及原API分页、normalized数据、发布/传输/checkpoint、host/runtime采样、清理和失败记录、评分历史与既有分析。原文件SHA与公开ORIGINAL_FILE_HASHES中的记录核对；公开字节有变化时检查其明确的转换记录和双hash。
- 34项状态/root/sessionTree与原件一致。102个session、116个message ID、15,624条normalized
  event/message/action记录的身份字段均逐项匹配；全部attempt文件中的769,580处session/message身份引用保留。
- 另对47份历史trace比较8,246个event的顶层及data身份字段，均与原件一致。中间错误脱敏造成的message/event
  ID改动没有留在最终候选。
- 四项补跑仍通过retryOf关联原结果，没有替换原30项失败。主30与补4不能合并成34个独立任务或best-of统计。原005用户中断、读取故障、OOM、030参考实现/测试应用与污染等结论均保留。

源码上下文单独验证了39个独立原归档：全部73,869个非Git普通文件均保留，成员的original
SHA逐一与原件核对，release
SHA逐一与公开字节核对；仅3个普通成员有明确字节转换。最终共有96,592个归档成员，其中8个链接均为归档内安全相对链接，无Git内部成员或设备文件。原52,368个Git内部成员已移除。原baseCommit、镜像身份、文件模式和patch上下文仍可用于合作分析，但本包不承诺逐字节恢复原Git库或Docker环境。

实际工作树源码、benchmark工具/文档、历史adapter快照、benchmark
sources/datasets及版本/许可资料均随包保留。私有DO/SQLite存储、凭据、Docker镜像和下载缓存按公开说明排除；保存的API导出、trace、patch和源码上下文足以支持本次声明的离线分析范围，不要求合作者访问原宿主或模型API。GitHub自动生成的tag源码包不能代替本协作包中的实际工作树快照。

## 完整性与使用边界

独立逐文件计算最终MANIFEST的hash/bytes，实际文件集合严格等于清单加MANIFEST自身。包内 `verify.py`
在最终候选上再次运行：`verifiedFiles=11239 / cohortAttempts=34 / errors=[]`。相对COHORTS路径、必需attempt材料、派生trace
hashes和原artifact SHA关联均通过。

README明确区分公开字节完整性与原历史证据：MANIFEST和重算后的trace
hashes验证公开派生文件；原artifact/source
hash、fingerprint和已有分析口径仍描述原实验。ORIGINAL_FILE_HASHES、TRANSFORMATIONS、EXCLUSIONS和NESTED_ARCHIVE_MEMBERS提供二者的对应关系。重新分析脱敏数据可能产生不同fingerprint或文本敏感指标，应把新输出写在已验证包之外。

现有分析成功不等于模型正确或样本干净；主30中的原失败与两次DSPy污染不能被公开打包步骤修饰为成功。资料包含研究用参考实现和测试，不应作为未来benchmark
agent的完整工作区。本阶段不重新运行评分或实验，也不扩大原有观测完整性的声明。

最终发布资产应对应本报告锚定的候选内容，并保留SHA256SUMS及下载后校验结果。本报告在仓库独立生成，不属于上述11,239份候选文件；如作为额外发布材料提供，应单独记录其发布摘要。
