# dsh-control native bridge (DSH bundle)

Registration-only bundle for the dsh-control native bridge.

- Install: `dsh plugin --profile <profile> add <this directory or the .tgz>`
- This bundle adds one patch row: `id: dsh-control-bridge`, `name: dsh-control-bridge`.
- `index.js` loads the digest-pinned execution snapshot from
  `$DSH_CONTROL_HOME/native-plugin/<sha256>/desktop-plugin.mjs` (or the explicit
  `snapshot` config value) and refuses to load when the snapshot content no longer
  hashes to its directory name.
- The bundle has no runtime dependencies and never needs a Desktop restart; the
  supervisor installer deploys snapshots and writes the profile override that
  selects `home`, `snapshot` and `revision`.
- Removing the bundle unregisters the layer. It does not delete run history or
  reports, which live under `$DSH_CONTROL_HOME`.
