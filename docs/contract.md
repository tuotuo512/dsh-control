# DSH supervision contract

Owner: this standalone infrastructure; Codex retains planning, scope, review and final decisions. DSH is an explicitly assigned worker. User trigger: “你来指挥 DSH / DeepSeek / DeepSeek Harness 工作”.

Public source release 0.7.0 is a Windows preview. Installation is documented in [INSTALL](INSTALL.md), with supported scope in [COMPATIBILITY](COMPATIBILITY.md).

## Distribution and lifecycle

**Artifact ownership.** Three parts, no overlap:

| Part | Owns | Never owns |
| --- | --- | --- |
| Codex plugin (`dist/codex-plugin`, marketplace `dsh-control-local`) | skills, interface metadata, plugin identity | MCP server declaration, execution authority |
| DSH bundle (`dist/dsh-plugin`, package `dsh-control-bridge`) | one patch row that registers the bridge | execution code, run state |
| `scripts/install.mjs` | digest-pinned deployments, both registrations, migration, rollback, uninstall | the workspace, the Desktop installation, other plugins |

**Single registration.** The fifteen tools are registered exactly once, in `<CODEX_HOME>/config.toml` as `[mcp_servers.dsh-control]`, pointing at `<DSH_CONTROL_HOME>/codex-server/<digest>/mcp.mjs`. The plugin manifest deliberately omits `mcpServers`: `${PLUGIN_ROOT}` is not expanded in MCP args, local marketplace plugins get no plugin cwd, and a freshly added plugin's MCP server is not visible to `codex mcp list` before Codex's own app sync (verified with codex-cli 0.169.0-alpha.11.1 on 2026-11-15). One registration channel means two bridges can never run.

**Bundles and snapshots.** `dsh plugin add` owns the profile dependency and the bundle list. Execution code stays in a digest-addressed directory `native-plugin/<sha256>` deployed by the installer; the bundle loader re-hashes the snapshot before import and refuses content that does not match its directory name. The profile override row (`id: dsh-control-bridge`) selects `home`, `snapshot` and `revision`. The `desktop` profile is owned by the Electron application and rejects `dsh plugin add` (verified 2026-11-15: `profile "desktop" is managed exclusively by the Electron application`), so that deployment uses the `file://` snapshot row; a single owned block exists in either mode, never both.

**Protocol versioning.** `src/protocol.mjs` owns `PROTOCOL_VERSION` (currently 1) and the capability list. The connection descriptor and `/v1/health` both carry it; a mismatch rejects the affected mutation with an explicit error. A descriptor written before versioning existed is accepted as a labelled legacy deployment (`protocolVersion: 0`, `legacyProtocol: true`, surfaced by `doctor`) so an in-flight deployment keeps working, and the next install replaces that plugin. Package version, protocol version, run-state schema, DSH version and installation digests are recorded separately. No incompatibility falls back to the SDK backend or to another model.

**Install and update.** `plan` is read-only. `apply` refuses while any managed run is live or has an unreleased lease, deploys snapshots, checks registration preimages before replacement, verifies read-back and writes a receipt under `<DSH_CONTROL_HOME>/install/`. Rollback restores only unchanged postimages still owned by that attempt; a concurrent writer's changes are preserved and reported for inspection. MCP registration explicitly carries its state directory so later sessions do not depend on the install shell's environment.

**Uninstall.** Refused while managed runs are live. Removes this project's profile block, Codex MCP entry, plugin registration and the standalone skill it installed. Keeps `runs/`, `report.md`, `events.jsonl`, receipts and connection data.

**Stage without activation.** `install.mjs stage` may run while tasks are live. It prepares and hashes immutable Native/MCP candidates and writes a staged receipt only; no profile, MCP registration, installed skill, current descriptor or task is changed. A staged receipt is not an installation receipt. Existing apply still requires all managed runs and leases to settle before activating either end. Staging does not schedule hidden installation or imply that an ended Codex chat will wake up.

**Foreign session stores.** Codex's own session store (`~/.codex/sessions`, `state_5.sqlite`, `session_index.jsonl`) is not owned by this project and is never written by the installer. Backups live beside the managed home (`<home>-backups`), never inside it, and generated exports stay out of the repository.

**Data vs cache.** Run state, reports, receipts and snapshots live outside `~/.codex/plugins` and outside `dist/`. Clearing a plugin cache or reinstalling the plugin never destroys monitoring data; the deployed server and snapshots are immutable and shared by digest.

## Runtime and state

Three explicit backends share the supervisor contract. `sdk` uses the installed Desktop CLI entry in Electron Node mode, official `--profile sdk`, JSON-RPC over stdio. `desktop` uses a local plugin in the already-running Desktop Host and the installed official Session Controller, Workspace Registry and Connection services. No Desktop restart, no extracted Desktop credential, no downloaded replacement runtime. Check the installed archive digest against config before starting. Preserve explicit provider/model/effort. Config and run data live at `DSH_CONTROL_HOME` or `~/.codex/dsh-control-state`. A failed Desktop connection never silently falls back to SDK.
A third, opt-in backend `acp` drives the shipped ACP server (`dsh --profile acp`) over standard ACP v1 stdio. It is selected explicitly by `start.backend: "acp"` (or `defaultBackend`) and is never a fallback. The supervisor keeps its own session identity and stores the agent-assigned id in `state.acpSessionId`; a continuation resumes that session with `session/resume` instead of creating a new one. The adapter keeps the supervisor's promise shape: `session/prompt` returns a receipt immediately, `session/wait` settles on the ACP prompt response (`stopReason`), and a cancelled prompt maps to the `cancelled` stop reason.

ACP exposes only one interactive request, `session/request_permission` (one-shot allow/reject). It maps to `awaiting_approval` and is answered through the normal `respond` path. There is no user-question operation on this backend, so a run that needs a blocking question cannot pause: the worker prompt instructs the agent to stop and report the question, and `doctor` reports `acp.interactiveQuestions: false`. `dsh_desktop_sessions` and `dsh_adopt` remain Desktop-only.

Model pinning is best effort and never silent. The ACP catalog names routes differently from the DSH config (observed `deepseek-flash` in config versus `deepseek-v4-flash` in the catalog, with values JSON-encoded as `[provider, model]`), so a match is applied through `session/set_config_option`; an unmatched model logs `model-unpinned` and emits a `model_unpinned` run event instead of claiming the assigned route. A `set_config_option` the agent rejects fails the run.

One background Node worker observes one run. For SDK it owns the child runtime; for Desktop the original Host owns the native Agent and the worker owns only its run-monitoring lease. Distinct sessions may run concurrently; maxParallel defaults to 2. A managed session has at most one live run. A continuation starts a new run on the same persisted session after the previous run releases it. Existing ordinary sessions require an explicit `adopt` operation while idle, with declared permissions and paths. Adoption sends no prompt. Busy/queued/pending/background-active sessions and cross-process writer contention reject; no silent takeover of an unrelated Desktop session.

New starts use config.defaultBackend; omitted legacy config means sdk. Explicit start.backend overrides it. Continuations retain the original backend, and legacy run records without backend remain sdk. The current machine deployment selects desktop.

Each mutation start/send/adopt has a caller supplied requestId. Repeating identical content returns the original run; changing content under the same requestId rejects. An uncertain or interrupted run is never automatically resubmitted. A short file lock serializes admission across CLI/MCP processes. Persistent state remains the recovery authority if an MCP connection closes.

States: starting, running, awaiting_input, awaiting_approval, closing; terminal completed, failed, cancelled, timed_out, interrupted, and `attached` (an explicitly adopted session with no executed turn). SDK `completed` requires the current run's completed turn, successful session/wait, and child runtime exit 0. Desktop `completed` requires the admitted request's completed turn and native Agent quiescence; release of its run-monitoring lease is not Host process exit. A tool result or accepted prompt is not task acceptance. Codex reviews actual files and tests separately. Foreign user input during a supervised turn invalidates exclusive attribution; the bridge reports interruption and does not cancel the user's replacement work.

## Scope and permissions

Permission is explicit per task, or inherited from an explicitly saved canonical-workspace policy; an unconfigured workspace remains read-only. Supported presets are read-only, workspace-write and danger-full-access. Full access is a native execution preset, not administrator elevation or permission to change Windows ACLs. Both write presets require ownedPaths inside the canonical workspace and participate in the same overlapping-writer checks. These paths remain task ownership, not filesystem enforcement; full access removes the workspace sandbox and can reach outside those paths. It never expands the assigned business task or authorizes commits, installation, publication or system changes.

`workspace_policy({cwd})` reads the separate workspace-permissions.json policy; `{cwd,permission,expectedRevision}` explicitly saves it, and permission:null removes that project's setting. Revision checks prevent lost updates; aliases resolve to a canonical directory, and parent policies are not inherited by child repositories. New start/adopt resolve an omitted permission; explicit task permission wins. send retains the existing session's assigned permission, even if a project default changes. No running task is upgraded, restarted or replayed. The connection notebook remains relationships only.

`preflight` performs zero-model, zero-chat runtime/host/workspace/policy/admission checks and reports blockers and the effective permission. It is an observation, not an admission receipt or proof that a restricted shell can start. Shell status remains not_probed until actual tool evidence exists; sandbox failures are reported separately and never trigger automatic ACL repair or a silent permission escalation. Reuse exact workspace/session inspection and bounded compact status/wait for routine supervision; do not skip mutation-time identity, archive, ownership or fingerprint checks to gain speed.

Questions and approval requests pause the run and are returned as structured pending input plus a Markdown report. A supervisor can respond explicitly; approval is not inferred from timeout. Deadline or cancellation stops only the managed task: SDK shuts down its owned child; Desktop cancels the native run and releases monitoring without terminating the Host. No undocumented session/cancel RPC is invented. Forced runtime termination may leave external side effects uncertain and is reported as such.

For Desktop, cancellation invokes the native controller only for the managed run; never kill the Host. The plugin creates its own documented in-process answering Peer, with its own lifecycle, and uses the same native forwarded-event stream as the UI. First valid answer wins and native cancellation clears competing displays. Events outside the active managed-session set are ignored, not persisted/exported, and not answered or delegated with `next`. The external bridge is separately authenticated by a random local credential that is never returned in tool results. It binds only `127.0.0.1`, rejects browser Origin requests and unexpected Host headers, and exposes a fixed allowlist rather than an arbitrary RPC proxy.

## Workspace selection

Select the target workspace before choosing a conversation. `desktop_workspaces` is read-only and lists the actual native Workspace Registry, including workspaces with no sessions. Each result carries stable `workspaceId`, display `title`, canonical `cwd` (native `path`) and `sessionCount`; `offset/limit/total/nextOffset` make truncation explicit. Titles are labels, not identities: different directories can have the same title.

For a new task in an existing workspace, `start` accepts `workspaceId` with `backend: "desktop"`. The supervisor resolves its current path before admission, stores the selected identity, and the native plugin rechecks it before creating the unique new session through `sessionController.create({sessionId, workspaceId})`. `cwd` remains required and must match that workspace's canonical path. Unknown/deleted identities, path conflicts and unsupported backends reject; they never fall back to the last conversation, the current UI selection, another workspace or a newly created workspace. Existing path-only starts remain supported for explicitly assigned paths.

Continuations keep their original workspace and session. A task for another workspace uses a separate new conversation under the user's delegation instruction; it does not move or interrupt the existing one. There is no hardcoded project-specific project or global conversation default that overrides a task's selected workspace. When project intent is ambiguous, resolve that ambiguity before submitting work. Installing the plugin does not itself register a user's projects.

## Native Desktop visibility

An SDK session's cwd is insufficient to update the live Desktop sidebar. Native Desktop starts must create/reuse the Workspace, call `sessionController.create({workspaceId, sessionId})`, set a native title, and send input through `sessionController.prompt`. The existing Host publishes its own membership and session/projection events. Never patch workspace JSON, fabricate a session-created event, inject renderer JavaScript or extract the Desktop owner's token to simulate this integration.

The local plugin is registered as one independently owned entry per immutable deployment snapshot through the official profile patch/HMR mechanism. Deployment copies plugin/host/store into a digest-addressed immutable snapshot and derives entryId from that digest. Reusing an id while changing its module name can retain the prior callback; use the new snapshot entry. Official profile/HMR applies the change without restarting Desktop. Only the plugin's independent entry is added; installation assets are unchanged. Record the profile preimage and verify the same Host PID and existing work after hot-load. File presence, plugin health, native API tests, and observed GUI behavior are separate acceptance claims.

The plugin is the execution authority for Desktop runs; the CLI/MCP state and reports are supervisor receipts. Restart or unload with an uncertain prompt never causes replay. Native session identity and durable history remain owned by DSH. The plugin stores only its managed-session allowlist, idempotency/lease records, and sanitized public run events.

Local HTTP contract: connection descriptor `desktop-connection.json` contains `schemaVersion`, loopback `url`, private `token`, `instanceId`, `pid`, archive digest and plugin version. `GET /v1/health` returns only non-sensitive facts. Fixed POST operations: `/v1/open`, `/v1/prompt`, `/v1/poll`, `/v1/respond`, `/v1/cancel`, `/v1/release`, `/v1/list-sessions`, `/v1/list-workspaces`, `/v1/inspect-session`, `/v1/adopt`. Poll uses monotonically increasing cursors and SDK-compatible public notifications/requests; it never returns provider reasoning. `control.input_cancelled` settles native UI/supervisor answer races. Close/release concerns one run, never the application.

## Return path

Select a project Workspace from task intent before choosing a related conversation within it. Prefer reuse; create a new conversation when explicitly requested or genuinely required by independent work within the delegation. Resolve material ambiguity only; no per-call confirmation or fixed project-specific/global default. Busy, unavailable or uncertain state never permits a replacement. New conversations use frontend-visible Desktop unless the user explicitly chooses another backend. Existing tasks retain their original backend, Workspace and Session without interruption, migration or duplicate submission. Inventory and receipts do not prove frontend visibility.

The relationship notebook `<stateDirectory>/conversation-bindings.json` uses schema 2: `{schemaVersion:2,projects:[{workspaceId?,title,cwd,conversations:[{sessionId,title,backend,linkedAt}]}]}`. Record only projects/conversations actually linked by Codex and DeepSeek; native projects may carry workspaceId. No defaultSessionId, runId, status, progress, todo or message content. Schema 1 migration retains relationships only. Desktop start/send register after a real open; adopt registers on success. SDK/ACP register after a successful prompt receipt. Checks refresh display data for registered entries, not all Desktop history.

Across days read doctor.bindingsPath first, then exact desktop_session existence/archive state and list/status run state/leases before sending. Checks require explicit boolean exists/archived values; unknown state preserves notes. Explicit archived/notfound removes the relationship and forbids sending; business history remains. Unavailable queries, disconnects and timeouts retain notes and grant no sending permission. Never infer deletion from a truncated inventory. Controller preflight and native open/prompt recheck existence/archive state to close races.

Status/wait/result return bounded public messages, tool summaries, terminal reasons and report paths directly to Codex. Never publish provider reasoning or request headers. Every run also has report.md, state.json and sanitized events.jsonl. Reports remain usable after disconnect/restart. An ended Codex chat is not automatically awakened; the skill keeps the current task monitoring until completion or records an explicit handoff. No background message is injected into another chat.

## Frozen controller API (all async exports in src/controller.mjs)

Native inspection can refresh or revoke only Desktop connections in the relationship notes. SDK/ACP connections use their original backend identities and recovery contracts; absence from the native registry is not evidence that one of those conversations was deleted.

- doctor({}) -> installed runtime/config/readiness, no secret values.
- workspace_policy({cwd, permission?: 'read-only'|'workspace-write'|'danger-full-access'|null, expectedRevision?: number}) -> exact canonical project policy; mutation requires expectedRevision, null resets to read-only default.
- preflight({cwd, workspaceId?, backend?, permission?, ownedPaths?}) -> start readiness, blockers, effective permission/source and shell:not_probed; zero task/chat/model calls. ACP full access is explicitly refused until that backend's preset behavior is verified.
- start({requestId, cwd, prompt, title?, workspaceId?, backend?: 'sdk'|'desktop'|'acp', permission?: 'read-only'|'workspace-write'|'danger-full-access', ownedPaths?: string[], timeoutSeconds?: number}) -> run snapshot. Required strings nonempty; cwd remains required. workspaceId is Desktop-only and must match cwd after canonicalization; unknown ids reject without creating a replacement. Native session create receives workspaceId without cwd. Default timeout 1800, 5..14400.
- send({requestId, sessionId, prompt, title?}) -> next run snapshot with stored workspaceId/cwd/permission/model/backend, after existence/archive checks.
- status({runId, afterEvent?: number, maxEvents?: number}) -> snapshot + events after cursor; default 20, max 100. Reasoning omitted.
- result({runId, maxChars?: number}) -> snapshot + public output + reportPath. Default 12000, max 50000.
- list({limit?: number}) -> {runs}; default 20, max 100.
- wait({runIds: string[], timeoutMs?: number, after?: object}) -> {reason, runs}; 1..8 targets, default 10000, max 30000. Wake on terminal/input state or public event cursor beyond provided per-run after cursor. No after cursor: wait for terminal/input.
- respond({runId, pendingId, response: object}) -> snapshot; SDK-shaped answer (`answers`/`cancelled`) or one-shot approval outcome. Reject stale/nonpending identity.
- cancel({runId}) -> snapshot with cancellation requested; terminal only after owned SDK child exit or native task stop/lease-release confirmation.
- desktop_workspaces({limit?: number, offset?: number}) -> {workspaces:[{workspaceId,title,cwd,sessionCount}],total,nextOffset}; read-only, includes empty Workspaces.
- desktop_session({sessionId}) -> {exists,archived,cwd,workspaceId,workspaceTitle,title,running,managed}; exact native lookup, not inferred from a limited list.
- desktop_sessions({limit?: number}) -> {sessions}; default 20, 1..100; read-only native session inventory.
- adopt({requestId, sessionId, permission?, ownedPaths?, timeoutSeconds?}) -> attached managed base snapshot; defaults read-only/1800 seconds, 5..14400. Explicitly adopts only an idle ordinary native session and submits no prompt; follow with send.

MCP exposes fifteen tools: dsh_doctor/preflight/workspace_policy/start/send/status/result/list/wait/respond/cancel/desktop_sessions/desktop_workspaces/desktop_session/adopt using those shapes. start/adopt accept the three presets above; omission resolves the project policy. status/list/wait also accept compact?:boolean to omit repeated runtime/path metadata while retaining pending, lease, error and report fields. CLI `node src/cli.mjs <operation> [--input <json-file>]` or stdin JSON invokes the identical controller. UTF-8 JSON result, nonzero on error. MCP stdout is protocol only. No controller operations depend on MCP being connected.

HTTP status/code distinguish explicit rejection from transport uncertainty. An explicit pre-admission busy/invalid adoption refusal releases the local lease. A 409 alone is insufficient because setup may already have side effects; ambiguous rejection, timeout or disconnect retains interrupted/leaseHeld and never causes replay. A rejected open with no ownership must not cancel someone else's run; prompt rejection after open still requires managed-run cleanup.

## Verification and release scope

Local tests, installed snapshot identity, Host-loaded plugin, actual model execution, frontend visibility and human acceptance are separate evidence. Public source delivery does not update an existing bridge. See [compatibility](COMPATIBILITY.md); private machine receipts are not distributed.

First setup is read-only by default and writes only with --write. It refuses existing configuration and unknown builds; installer apply requires setup and no live managed lease. npm ci installs dependencies without plugin lifecycle effects. Source export uses an allowlist, excludes development Git history/private records/state/node_modules, and is reviewed independently of installation. MIT licensing does not change native application licensing or access rights.
