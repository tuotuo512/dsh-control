---
name: dsh-control
description: "Use when the user asks Codex to supervise local DeepSeek Harness tasks, e.g. 'delegate to DeepSeek Harness' or ‘你来指挥 DSH / DeepSeek / DeepSeek Harness 工作’. Not for ordinary model comparisons or API configuration questions."
---

# Supervise DeepSeek Harness

Codex owns intent, scope, permissions, coordination, review and final acceptance. Harness executes bounded assigned work. Continue within the authorized delegation without asking permission each round; do not expand it to publishing, installation or unrelated effects.

## Discover the actual bridge

Discover fifteen dsh-control tools: doctor, preflight, workspace_policy, start, send, status, result, list, wait, respond, cancel, desktop_workspaces, desktop_session, desktop_sessions, adopt (all MCP names have `dsh_` prefix). Begin with doctor and compact list to verify the deployed identity and existing tasks. Do not install another Harness, downgrade models or restart the Desktop Host.

CLI uses the identical controller and argument shapes. From a source checkout use `node src/cli.mjs <operation>`. For an installed deployment, use doctor.stateDirectory to read the latest installation receipt and locate `serverDir/cli.mjs`; do not pick an arbitrary old snapshot. Use UTF-8 JSON files with `--input` or stdin. doctor/list/desktop_workspaces/desktop_sessions may omit input. Read [operations](references/operations.md) for parameters.

## Choose project, then conversation

Read doctor.bindingsPath across days, then check live state. This schema2 notebook records only linked projects and conversations, never progress, todos, chat content or a global default. Select a native workspace by task intent using paginated desktop_workspaces (including empty workspaces), then prefer a relevant existing conversation in that project. Titles are labels; use stable IDs. Ask only for material ambiguity. Create a conversation when explicitly requested or genuinely required for independent work within the delegation. Busy, unavailable or uncertain state does not permit replacement.

Use desktop_session for exact exists/archived/cwd/workspaceId/title/running/managed checks; also check task status and leases. Explicit boolean archived/notfound removes the notebook relationship and forbids sending; unknown queries preserve notes. Never infer deletion from a truncated list. Native open/prompt rechecks identity and archival. start requires cwd; optional workspaceId is Desktop-only and must match its canonical path. Unknown IDs reject without creating an alternative workspace. send retains the original session, workspace, cwd and backend.

New conversations default to frontend-visible Desktop: explicitly select backend desktop unless the user chooses another route. Verify actual UI visibility separately from receipts/inventory. Existing SDK/ACP/background tasks continue on their original route without interruption, migration or duplicate submission. Desktop failure does not authorize silent fallback.

## Delegate and finish

Give each worker necessary context, cwd, owned files, permission and acceptance conditions; it does not inherit this chat automatically. Omitted permission follows the saved project policy, otherwise read-only. Both workspace-write and danger-full-access require absolute ownedPaths; follow the target repository's isolation rules. Ownership coordination is not a per-file security sandbox. Full access also disables approval prompts; it does not authorize unrelated effects or administrator/ACL changes. Only save a project's policy when the user has authorized that choice; do not infer full access from a blocked shell. Existing sessions retain their assigned permission.

## Fast path without losing identity

Use preflight with the exact cwd, workspaceId and ownedPaths to combine runtime, native host, project policy and writer checks without creating a chat or calling a model. It reports shell:not_probed: configuration readiness is not proof that pwsh works. Explicit permission overrides the project default. To remember a user's choice, read workspace_policy, then save permission with its expectedRevision; null removes it. Do not put permissions into the relationship notebook. Current-tool schemas may be stale after an update: use the same implementation's CLI rather than dropping fields or switching backend.

Keep the actual assignment short (normally 5-10 lines): goal; required document/section; files owned; observable acceptance and relevant checks; constraints. Put code maps, rationale and historical evidence into the referenced task document. Do not repeat whole documents, require a fresh plan-only reply, or assign a fixed project. A worker should read the task document and perform one cheap shell check early; on a sandbox provisioning failure it reports once, uses file tools where possible, and leaves command checks to the supervisor. Never automatically repair Windows ACLs, increase permission, resend or cancel to clear a blocker.

For routine monitoring use list/wait with compact:true and per-run event cursors. Fetch bounded status events only for new blockers or important progress; collect the full result once at the review boundary. Preserve pending IDs, terminal/lease checks and mutation-time revalidation. Do not poll without a cursor or repeatedly dump the same runtime, path list and old tool output.

Use a stable requestId; retry only with the same arguments and identity. Unknown outcomes require inspection, never a fresh-ID replay. Adopt only explicitly selected idle native sessions after exact checks; adoption submits no prompt. Never seize an unrelated active task.

Track accepted work with wait (at most 30 seconds per call), status and result. Handle pending input using the original pendingId and one-shot approval only. Existing authorization may answer routine questions; scope expansion or user-only decisions require the user. Do not answer for unmanaged sessions.

completed means a settled execution turn, not accepted work: review actual changes and evidence. Reports remain under stateDirectory/runs/<runId>/report.md; task progress belongs there, not in the relationship notebook. Reuse send only after the prior run ends and releases its lease. Interrupted/timed-out/unknown tasks are not automatically replayed. Cancel affects the managed task only, never the Host.

The bridge does not wake an ended Codex chat. Keep monitoring in the active task or explicitly hand off. A delegated Harness worker must not invoke this skill to delegate again. Source changes, installed snapshot and loaded native plugin are separate facts; no installation or restart is implied by this workflow.
