---
name: dsh-control
description: "Connect Codex to local DeepSeek Harness: select projects and conversations, send messages, read results, and relay questions or approvals. Use when the user asks to connect to or control DSH / DeepSeek Harness."
---

# DeepSeek Harness connection

This skill describes the connection tools, not how to manage or implement a project. Task content, roles, methods, boundaries and acceptance criteria come from the conversation and project instructions. The plugin transmits the caller's prompt unchanged; connection metadata is not added to the model message.

## Locate the connection

Use dsh_doctor for installed identity, state directory, readiness and backend capabilities; dsh_list with compact:true shows existing runs. CLI and MCP use the same controller. If current MCP schemas are stale, locate serverDir/cli.mjs through the latest installation receipt under doctor.stateDirectory and pass UTF-8 JSON with --input or stdin. The source-checkout entry is node src/cli.mjs. See [operation shapes and examples](references/operations.md).

## Select project and conversation

Use desktop_workspaces to list native workspaces, including empty ones. Identify the intended project by workspaceId and canonical cwd; titles are labels. Read the relationship notebook at doctor.bindingsPath for previous connections, then check current state with desktop_session. It returns exact existence, archival, workspace and running state; an unavailable or truncated query does not prove deletion.

New connections normally use the frontend-visible Desktop backend; other backends are explicit choices. Inventory and receipts do not prove that the UI was observed. Continuations keep their session, workspace and backend. start creates a new session, send continues a managed idle one, and adopt registers an idle existing native session without sending a message. Native admission rechecks identity and availability.

## Send and receive

Pass the intended prompt directly. The plugin does not add a role, file list, task template, work method or project policy. Permission is an explicit argument or saved exact-project policy; an unconfigured project defaults to read-only. Full access disables the sandbox and approval prompts. For writing connections, omitted ownedPaths reserves the workspace against overlapping writers; an explicit list is an optional coordination partition, not an instruction about which files solve the task.

workspace_policy reads or revision-checks a saved permission; permission:null resets it. Existing sessions retain their assigned permission. preflight observes runtime, project, permission and reservation conflicts without creating chats or calling a model; shell:not_probed means command execution has not been tested. ACP exposes approvals but no user-question operation, as reported by doctor.

Use stable requestId values: an identical retry returns the existing receipt, changed arguments reject. Unknown delivery results must be inspected before retrying. Use wait with per-run cursors and compact:true for bounded monitoring, status for incremental events, and result for public output/reportPath. Questions and approvals are relayed through pendingId and respond. Completion describes a settled run, not acceptance of its work. Run data survives MCP disconnects.

## Connection lifecycle

cancel affects the selected managed run, never the Desktop Host. Busy or uncertain state does not make a session replaceable. Native-code replacement waits for active leases; supervisor-only updates preserve serving native instances and old workers. The bridge does not wake an ended Codex chat. Installed package, native snapshot, loaded Host and observed UI are separate facts.
