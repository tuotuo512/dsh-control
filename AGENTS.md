# DSH Control contributor rules

Read docs/contract.md before changes. This repository owns the supervisor bridge, not the installed Harness application or consumers' projects. Do not patch application installation files, download a second runtime or copy credentials.

Use supported Host services or the installed SDK. Pin verified installation identity; source, deployed snapshot and Host-loaded plugin are separate facts. Preserve current tasks, never infer completion from enqueue acceptance, and never automatically replay unknown submissions. Cancel managed work only, never the Desktop Host.

Validate with node --test test/*.test.mjs, then bounded isolated MCP/native integration when explicitly authorized. Fixture tests are not live application acceptance. Never execute destructive commands against computed directories without checking the absolute target and ownership. Do not repurpose system variables such as HOME.

Public delivery uses an allowlist export without development .git, private verification records, state or credentials. Keep English and Chinese installation instructions aligned. Do not claim repository publication or installation verification that has not occurred.
