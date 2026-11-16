# Changelog

## 0.7.0 — Project permissions and faster supervision

- Save an explicit default permission for each canonical project, including native full access; new tasks may inherit it while existing sessions keep their original assignment.
- Add zero-chat, zero-model preflight checks and native permission catalog/readback validation (15 supervision tools total).
- Add compact status/list/wait responses and shorter document-driven task instructions to reduce repeated context.
- Prepare verified update candidates with `stage` while active work continues; activation still waits for managed tasks and leases to settle.
- Diagnose Windows sandbox provisioning failures without automatic ACL repair or permission escalation. ACP full access remains unverified and is refused.
- Preserve existing request receipts, writer-conflict checks and older native snapshot verification across upgrades.
- Model-free tests and package checks do not sign real full-access execution or human UI acceptance. Publishing does not update a running installation.

## 0.6.0 — Windows public preview

- Portable first-run setup with read-only planning, explicit installation/profile overrides and a verified application-build allowlist.
- Separate dependency installation from bridge activation; `npm ci` never registers the plugin.
- Thirteen supervision tools, native workspace selection, exact archive/existence checks and project-to-conversation relationship notes.
- English and Simplified Chinese documentation, MIT license, clean source export and source/bundle archives with SHA-256 checksums.
- Existing author installations and ongoing conversations remain independent of release preparation.

## 0.5.0 — Local validation

- Workspace discovery, reusable project/conversation associations and archived-session refusal were validated in a local Windows installation. Personal execution records are not part of the public release.
