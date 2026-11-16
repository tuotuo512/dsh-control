# 操作参考

CLI and MCP share src/controller.mjs. MCP server: dsh-control. State defaults to ~/.codex/dsh-control-state; DSH_CONTROL_HOME overrides it without changing Harness credentials or session storage. From a checkout run node src/cli.mjs; installed CLI lives in the latest install receipt serverDir under doctor.stateDirectory.

| 操作 | 主要参数 | 含义 |
|---|---|---|
| doctor | `{}` | 安装版本、摘要、模型和配置就绪情况 |
| workspace_policy | cwd, permission?, expectedRevision? | 读项目默认权限；保存需当前 revision，permission:null 清除；不改变既有会话 |
| preflight | cwd, workspaceId?, backend?, permission?, ownedPaths? | 不建聊、不调用模型，检查运行环境、项目权限、路径和写入冲突；shell 未实测会明确标记 |
| start | requestId, cwd, prompt, title?, workspaceId?, backend?, permission?, ownedPaths?, timeoutSeconds? | 新会话与首轮任务；默认只读、1800 秒 |
| send | requestId, sessionId, prompt, title? | 复用受管历史会话，等待前一轮停止并释放租约后执行；保留原后端 |
| status | runId, afterEvent?, maxEvents?, compact? | 状态与增量公开事件，返回 nextEvent；compact 去掉重复大字段 |
| result | runId, maxChars? | 输出、工具摘要、状态和 Markdown 路径 |
| list | limit?, compact? | 最近任务；新聊天恢复入口，日常使用 compact:true |
| wait | runIds, timeoutMs?, after?, compact? | 最多 8 个目标，单次最多 30000 毫秒；after 是 runId 到 eventCursor 的映射 |
| respond | runId, pendingId, response | 回答原问题或一次性审批 |
| cancel | runId | 取消受管任务；原生仅释放任务监控，不结束 Host；必须查终态 |
| desktop_workspaces | limit?, offset? | 只读分页工作区，含空工作区；返回 workspaces、total、nextOffset |
| desktop_session | sessionId | 精确查询存在、归档、工作区、运行与受管状态 |
| desktop_sessions | limit? | 只读列举原生会话，默认20，1..100；检查 running/managed |
| adopt | requestId, sessionId, permission?, ownedPaths?, timeoutSeconds? | 明确接管空闲既有原生会话，不发 prompt；返回 attached，之后 send |

API 的 defaultBackend 控制省略 backend 时的后端，旧配置缺省 sdk；start.backend 可显式指定 desktop、sdk 或 acp。主控的用户偏好见 [workflow](../SKILL.md)：新建对话显式传 `backend: "desktop"`，其它新建后端须由用户明确选择，不因配置缺省而自动走后台。原生不可用时报告，不自动换入口。send 保留会话原后端；旧记录没有 backend 时按 sdk 解释。已经运行的前端不可见任务继续执行，不为切换默认通道而取消、迁移或重发。

## 项目与对话关系笔记

先按任务意图选择 DeepSeek 原生工作区，再选该项目相关历史对话；不写死 a fixed project 或全局默认。优先复用，明确要求或授权范围内独立工作确实需要时才新开；实质歧义才问，不强制每次确认。忙碌、不可用或未知状态不是新建替代许可，已有任务保留原通道与工作区，不打断或重复派发。

跨天先读 `doctor.bindingsPath` 指向的关系笔记（即 `<doctor.stateDirectory>/conversation-bindings.json`），再实时检查。schema2只记 Codex 与 DeepSeek 关联过的项目及对话：`{schemaVersion:2,projects:[{workspaceId?,title,cwd,conversations:[{sessionId,title,backend,linkedAt}]}]}`。原生项目可带workspaceId；无defaultSessionId、runId、status、进展、待办或聊天内容。旧schema1仅迁移对应关系。Desktop在start/send真实open后、adopt成功后自动登记；SDK/ACP在成功prompt receipt后登记，检查刷新已登记项显示信息，不导入整个Desktop历史。

用 `desktop_workspaces({limit?,offset?})` 只读分页列工作区，含空工作区，返回 `{workspaces:[{workspaceId,title,cwd,sessionCount}],total,nextOffset}`。用 `desktop_session({sessionId})` 精确查 `{exists,archived,cwd,workspaceId,workspaceTitle,title,running,managed}`，不以截断清单推断不存在；另以list/status核任务、权限与租约。检查必须返回明确的 exists/archived 布尔值；未知状态保留笔记。明确归档/不存在会从笔记移除并禁止再发，但不删业务历史。断连、超时、查询不可用保留笔记，不视为删除或发送许可。controller预查后native open/prompt再次检查存在与归档。

start仍必填cwd，workspaceId仅Desktop可选；指定id必须与cwd规范路径相等，未知id拒绝，不按cwd新建替代。send保持原sessionId、workspaceId、cwd和backend。

desktop_workspaces 的 limit 默认100、范围1..100，offset 默认0且为非负整数；nextOffset 为null表示末页。CLI的 doctor/list/desktop_workspaces/desktop_sessions 可省略输入；其他操作使用JSON文件或stdin。

## 示例

项目默认权限单独保存，不进入关系笔记。先 `workspace_policy({"cwd":"D:\\some-repository"})`，再用返回的 revision 明确保存：

```json
{"cwd":"D:\\some-repository","permission":"danger-full-access","expectedRevision":0}
```

完全访问意味着无文件沙箱、无审批提示；不等于管理员、不授权系统设置或目录权限修复。清除该设置用 permission:null 和当前 revision。随后 start 省略 permission 即可沿用；已存在会话的 send 不随默认变化升级。两种写模式都须 ownedPaths，不能覆盖另一任务负责的文件。

新建前可用 `preflight({"cwd":"D:\\some-repository","backend":"desktop","ownedPaths":["D:\\some-repository\\src"]})`；ready 只证明列出的准备项，shell:not_probed 不代表命令已实测。ACP 完全访问尚未验证时明确拒绝，不换后端代跑。日常监控用 list/wait 的 compact:true 和增量 cursor，详细 result 留到验收再取。

存在/归档的原生检查只清理 backend为desktop的关联；SDK/ACP使用原后端身份与恢复合同，不用原生查询的“不存在”删除它们。

```json
{
  "requestId": "task-20261115-owner-a-first",
  "backend": "desktop",
  "cwd": "D:\\some-repository",
  "title": "定位资源索引的实际 owner",
  "prompt": "只读定位……。给出实际文件、调用关系、已证实结论和未验证边界。",
  "permission": "read-only",
  "timeoutSeconds": 1800
}
```

写任务显式添加 `"permission": "workspace-write"` 与 `"ownedPaths": ["D:\\some-repository\\src\\module"]`。ownedPaths 在 cwd 内，防止同时两个任务认领重叠路径；真正隔离并行施工用不同 worktree。

既有原生会话先用 desktop_session 的 JSON 输入（例如 {"sessionId":"actual-native-session-id"}）精确确认存在、归档和状态，再接管：

```json
{"requestId":"adopt-20261115-existing-001","sessionId":"actual-native-session-id","permission":"read-only","timeoutSeconds":1800}
```

接管成功只返回 attached；用新的稳定 requestId 和该 sessionId 调用 send 才会执行。running=false 只是列举时的观察，adopt 会再次检查排队、待答问题和后台活动；拒绝后不要自动取消作者任务。

参数上限：status.maxEvents 默认20、1..100；result.maxChars 默认12000、1..50000；list.limit 默认20、1..100；wait.timeoutMs 默认10000、0..30000。start/adopt.timeoutSeconds 默认1800、5..14400。

回答问题时，保持实际问题 ID 和选项 label：

```json
{"runId":"run-...","pendingId":"...","response":{"answers":[{"id":"actual-question-id","selected":["actual option label"]}]}}
```

开放问题使用 `selected: []` 和 `custom: "回答内容"`。取消问题传 `{"cancelled":true}`；一次性权限请求传 `{"outcome":"allowed-once"}`、`rejected` 或 `cancelled`。仅在当前授权足够时允许一次；不得自动批准扩大范围的请求。

问题通过原生共享请求进入界面和主控；先答者生效，另一端收到撤销。审批只允许一次性 outcome。明确忙碌等接管前拒绝会释放本地占用；超时、断连或可能部分生效的拒绝保留未知状态，禁止自动重放。

## 状态与恢复

`starting/running/closing` 仍未结束；`awaiting_input/awaiting_approval` 需处理。终态为 `completed/failed/cancelled/timed_out/interrupted/attached`。attached 仅表示空闲会话已接管，无执行回合。SDK completed 要求本轮明确完成、等待返回、子运行时退出 0；原生 completed 要求本次 requestId 输入对应的 completed turn、Agent 空闲凭据和监控释放，不伪造 Host 退出码。仍需主控独立验收任务。

每个任务目录包含 state.json、公开 events.jsonl、report.md、权限覆盖和 worker.stderr.log（仅执行器诊断）。不保存模型隐藏推理和请求头。配置不包含 API 密钥；DSH 使用原有凭据机制。

MCP 断开不会结束后台任务。用新连接 list/status/result 重新取回记录。任务超时后会取消受管任务；Desktop Host 保持运行。进程异常不能自动重发；`leaseHeld` 表示可能仍有旧运行时，SDK cancel 核对独有启动路径，原生 cancel 通过连接核对当前 Host 并操作受管 run，均不按旧 PID 盲目杀进程。

若发现 stale admission.lock，先停止新的派工调用，读取锁记录并验证 owner 进程已经退出，再只删除 `DSH_CONTROL_HOME/admission.lock`。不要删除状态目录、会话或仍有效的锁。此流程故意不做自动抢锁，以免多个恢复者误删新锁。

DSH 更新导致 doctor 摘要变化时，核对当前官方 SDK 合同和实际安装，再修改 config.json 的验证版本/摘要并跑有界联验；不要直接重跑 setup 来覆盖历史验证。暂时不能联验时报告阻塞，不下载旧版代替当前安装。

原生插件发布使用摘要固定的 plugin/host/store 快照及独立 entryId，通过官方 profile/HMR 热加载，无需重启作者 Desktop。源码已修改不等于当前 Host 已加载；doctor、快照摘要和真实界面验证分别核对。See docs/COMPATIBILITY.md for the supported preview scope.
