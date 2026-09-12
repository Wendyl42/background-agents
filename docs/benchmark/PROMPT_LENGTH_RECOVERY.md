# 009 长提示提交阻断与恢复记录

2026-09-10，批次 `acceptance-30-001-behavior-v2`。原始证据与恢复程序保存在外部
`runs/audits/prompt-length-block-1789018224918/`，独立验收见
[PROMPT_LENGTH_RECOVERY_REVIEW.md](PROMPT_LENGTH_RECOVERY_REVIEW.md)。

## 定位

006、007模型完成，008达到原deadline；三项的最终产物、trace、分析和清理均complete，评分均按配置跳过。原001–005继续引用旧批次证据。009
Pytest在首次提示提交时被HTTP400拒绝，整批因持久化prompt_intent进入blocked，010–030尚未创建。

009完整提交为77,643个UTF-16字符，超出原API/内部队列复用的64,000字符Web输入限制。路由将Zod长度错误统一显示为content
is
required，Python客户端只显示HTTP状态码；因此仅看runner摘要无法区分缺内容和过长内容。对实际原文的纯schema复现已确认该原因。第014项为66,169字符，也会触发同一限制。没有截断或改写benchmark原题/附录。

停止后的控制平面DB与WAL已备份；在副本上查009的messages为0，唯一event为ready。容器归属已核对：root
session `907666c53a5a9306fa4d7aa8eb388d8b`，native sandbox
`7aabe0c4-738f-444b-abbd-490f2abf8e4b`，容器
`76d39ebff9be5c8d1f46a403b60dc322516e74324a025ae8d35b0161d00c1f31`。没有模型prompt.start；这是入队前的确定性拒绝，不能计为模型解题失败。

## 修复与验证

共享类型新增MAX_API_PROMPT_CHARS与apiPromptContentSchema，将API及内部队列上限统一为128,000；Web输入仍用原MAX_WEB_PROMPT_CHARS。路由对超长内容返回明确的长度限制错误。shared先构建再验证control-plane，边界schema75项、路由/队列10项通过；shared和control-plane类型检查、ESLint与Prettier通过。30项纯文本长度检查全部适配，没有重做环境校准、构建镜像或模型试跑。

源码、编译产物和工作树差异已另存control-plane-revision.json及revision-source/，revisionId为
`prompt-api-128k-001`，从009起记录。17份Python
runner快照、冻结配置、任务清单、模型参数与镜像均未变。旧来源批次和001–008全部文件有protected-file-hashes.json，恢复前后核对；原009、CP和launch记录另存。

## 有据恢复

恢复程序先持有coordinator与batch锁，核对确定的400、原状态/提示hash、CP已退出、当前DB/WAL与零消息副本相同、容器身份和运行状态。只在这些条件满足时采集原容器，要求仍为空patch；然后为尚未使用的同一容器按当前配置恢复完整TTL，保存renewal-intent/result。

原prompt_intent、错误、请求时间和原deadline归档为submissionRejections并保留原状态副本；同一009/root的phase改为created，正常runner再进行第一次成功提交并设置正常deadline。这一例外只适用于已证明在入队前拒绝的请求，不改变对网络超时等未知POST结果的“不自动重发”规则。原始阻断继续留在infrastructure、异常索引及本审计中。

009的allocatedAtMs仍保留首次分配时间，故其总墙钟时间包含阻断排查等待；submissionRecovery明确记录这一段基础设施开销，不能当作模型执行耗时或增加的模型预算。实际消息开始/结束时间仍来自trace。

修复与恢复实际结果已独立验收PASS。原009容器采集为空patch，按配置将TTL续至2026-09-10 06:22:03
UTC；原模型尚未执行，因此没有增加已执行模型的预算。原688份保护文件复核全同。独立runner已接续，unit为
`oi-bench-acceptance-30-001-behavior-v2-1789019014868-22a22eb1.service`，PID300268。首次有效提交的启动核对已保存在本审计目录restart-handoff.json：009仍为同一root，只有一条与原文SHA完全一致的有效消息
`248b74d3e048d947faca88baffbf59c4`，状态processing；正常执行预算1,800秒，officialScoring=false，688保护文件全同。此后结束Codex本轮，不持续守候。
