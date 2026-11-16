# DSH Control

[简体中文](README.zh-CN.md) · [Installation](docs/INSTALL.md) · [Compatibility](docs/COMPATIBILITY.md) · [API contract](docs/contract.md)

Let Codex delegate bounded tasks to your locally installed DeepSeek Harness. Codex keeps planning and acceptance; DeepSeek executes assigned work. Native Desktop sessions remain visible in DeepSeek Harness, while durable reports survive MCP reconnects.

**0.7.0 Windows preview · Node.js 22+ · MIT.** Existing Desktop/SDK integration was tested with DeepSeek Harness 0.2.2-rc.3; the new permission and fast-path contracts have model-free coverage. Real full-access execution, other application builds and operating systems are unverified. Source and releases: [tuotuo512/dsh-control](https://github.com/tuotuo512/dsh-control).

## Install from source

Use the source checkout or published complete-source archive. See the [step-by-step guide](docs/INSTALL.md).

```powershell
npm ci
npm run build
npm run setup -- --plan
npm run setup -- --write
npm run install:plugin -- plan
npm run install:plugin -- apply
npm run install:plugin -- verify
```

`npm ci` installs dependencies without installing the plugin. Setup inspects the existing installation and account/model configuration, refuses unknown builds and existing configuration, and never copies provider credentials. Review the plan before writing. The installer connects both ends through a local MCP bridge; enabling a skill alone in a plugin marketplace does not connect to DeepSeek Harness. These instructions do not claim remote GitHub marketplace installation has been tested.

## Work by project

The fifteen tools are `dsh_doctor`, `dsh_preflight`, `dsh_workspace_policy`, `dsh_start`, `dsh_send`, `dsh_status`, `dsh_result`, `dsh_list`, `dsh_wait`, `dsh_respond`, `dsh_cancel`, `dsh_desktop_workspaces`, `dsh_desktop_session`, `dsh_desktop_sessions`, and `dsh_adopt`. CLI operations use the same names without `dsh_` and the same controller. Save a permission per project, preflight before starting, and use compact monitoring to reduce repeated output; see [operations](skill/references/operations.md).

List native workspaces, choose the project, then reuse its relevant conversation. A Desktop start requires `cwd` and may specify `workspaceId`; their canonical paths must match. Unknown identities reject rather than creating a replacement. Only create a conversation when requested or needed for independent delegated work. Busy or unknown state is not permission to duplicate work.

`doctor.bindingsPath` identifies the relationship notebook: projects and conversation identities only, no chat content, progress or todo list. Across days read it, then check exact native existence/archive state and current run leases. Confirmed archival/deletion removes the link and prevents sending; query failures preserve notes. Existing tasks retain their original backend and are never interrupted to change defaults.

```powershell
node src/cli.mjs doctor
node src/cli.mjs desktop_workspaces
node src/cli.mjs start --input C:/work/task.json
```

Default new work uses the frontend-visible Desktop backend and a saved exact-project permission, otherwise read-only. SDK and ACP are explicit alternatives, never silent fallbacks. Both write modes require explicit `ownedPaths`; this coordinates ownership, while only workspace-write retains the workspace sandbox. Full access disables sandboxing and approval prompts without expanding the assigned task. Acceptance is not completion: inspect reports and actual changes. Unknown submissions are never automatically replayed. See [operations](skill/references/operations.md).

## Maintain and publish

Use `npm run install:plugin -- plan/apply/verify/uninstall` for lifecycle operations; apply refuses active managed work and requires setup. Uninstall retains task history and reports. Do not restart the Desktop Host or replace a working installation to recover a task.

```powershell
npm test
npm run release:check
npm run release:export -- --out ../dsh-control-public
```

The public export uses a source allowlist and excludes development Git history, private verification records, state and node_modules. Release delivery provides a source archive, a prebuilt bundle and SHA-256 checksums; see [releasing](docs/RELEASING.md). The operator creates/pushes the GitHub repository and release. Local fixture tests, real Harness integration and human acceptance are separate evidence. This source release does not upgrade an existing installed bridge automatically.
