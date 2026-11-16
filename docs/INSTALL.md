# First installation

[简体中文](INSTALL.zh-CN.md) · [README](../README.md)

Use Windows, Node.js 22+, and an existing compatible DeepSeek Harness 0.2.2-rc.3 installation. Sign in and configure the desired model in Harness itself. Other builds and operating systems are unverified; see [compatibility](COMPATIBILITY.md). Obtain the source checkout or complete-source archive and open a terminal at its root. The intended GitHub repository is tuotuo512/dsh-control; these instructions do not assert it has been published.

```powershell
npm ci
npm run build
npm run setup -- --plan
```

Setup defaults to a read-only inspection. Review the discovered executable, profile, backend and model. To override discovery, use `--executable`, `--home`, `--dsh-home`, `--profile`, `--provider`, `--model`, `--reasoning-effort`, `--backend` or `--max-parallel`. Desktop is the default backend. Do not put credentials in arguments. Setup reads existing account/model configuration without copying credentials, rejects unsupported builds, and refuses to overwrite existing configuration.

```powershell
npm run setup -- --write
npm run install:plugin -- plan
npm run install:plugin -- apply
npm run install:plugin -- verify
node src/cli.mjs doctor
node src/cli.mjs desktop_workspaces
```

Apply requires successful setup and refuses managed work that is still live or holds a lease. Do not stop existing work to force installation. This installs a local MCP bridge plus supporting skills/native plugin; a marketplace skill checkbox alone is insufficient. No remote marketplace install is claimed verified.

For a custom state directory, pass the same `--home` to setup and every installer command, or set `DSH_CONTROL_HOME` for the commands. The installer persists that state path in the MCP registration; future Codex sessions do not depend on the shell's environment. Use `npm run doctor -- --home <path>` to inspect that installation. Keep any `--dsh-home`, `--profile` and `--codex-root` overrides consistent as well.

If the current Codex chat has not loaded the new tools, use the CLI with the same controller. From a checkout use `node src/cli.mjs`; for an installed deployment, run doctor and locate the latest installation receipt under its stateDirectory, then use that receipt's `serverDir/cli.mjs`. Do not choose an arbitrary old digest directory.

Use a bounded read-only first task. Select a workspace from desktop_workspaces, then pass its canonical cwd and workspaceId to start using a UTF-8 JSON file. Inspect status/result and verify frontend visibility separately; inventory alone does not prove visible UI. Unknown or failed submissions must not be replayed under a new requestId.

For maintenance run `npm run install:plugin -- plan`, then apply only after existing managed tasks finish; verify afterward. Uninstall uses `npm run install:plugin -- uninstall` and retains runs/reports. An existing configuration is not reset by first-time setup. Diagnose errors with doctor; never delete state, copy credentials, install a second Harness, or restart the Host as a shortcut.

To prepare an update while workers are busy, use `npm run install:plugin -- stage`. It copies and verifies immutable candidates without changing registrations or current tasks. After all managed work releases its leases, run apply and verify. Stage is not activation and does not schedule an automatic update.

Project permissions are separate from connection notes. Read `workspace_policy` with the exact cwd, then save `permission` and `expectedRevision`. Modes are read-only, workspace-write and danger-full-access (no sandbox or approval prompts). Omitted start/adopt permission follows that project's setting; existing conversations retain theirs. Writers reserve the workspace by default, or an explicit ownedPaths partition for coordination. This metadata is not added to the model message. Preflight does not create chats or call a model; shell execution remains not_probed. See [operations](../skill/references/operations.md).

For a Codex-side server/skill change compatible with the serving native protocol, `npm run install:plugin -- apply --component supervisor` updates only that side. It keeps the native profile/instance and active workers unchanged, checks their identity before/after, and records the two component versions separately. A full native update still waits for managed work to settle.
