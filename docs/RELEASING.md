# Preparing a public release

The public repository is generated from an explicit source allowlist. Development histories, personal validation reports, Codex history-recovery helpers, installed configurations, relationship notes, exports and dependency caches are excluded. Keep the original development repository and its history private; publish the generated directory with a fresh Git history.

```powershell
npm ci
npm test
npm run build
npm run release:check
npm run release:export -- --out ../dsh-control-public
```

The destination must be new or empty and outside the source checkout. Existing data is never deleted. Review the exported tree, initialize its own Git repository and run the checks there. The generated `plugins/dsh-control` folder and `.agents/plugins/marketplace.json` provide a marketplace projection of the skill. A complete installation still requires the local runtime setup and installer described in [INSTALL.md](INSTALL.md); installing a skill alone does not create a bridge.

From the clean public checkout, after building:

```powershell
npm run release:archive -- --out ../dsh-control-release-assets
```

Upload the two `.tar.gz` files and `SHA256SUMS.txt` as GitHub Release assets. The source archive requires `npm ci` and a build. The bundle archive already contains `dist` and its runtime dependencies: use `node src/setup.mjs --plan`, `node src/setup.mjs --write`, `node scripts/install.mjs plan`, `node scripts/install.mjs apply`, `node scripts/install.mjs verify`, then `node scripts/doctor.mjs`. It does not include Node.js or either desktop application.

GitHub CI runs model-free contract and package checks. It does not prove another computer's Desktop integration, provider access, model execution or UI acceptance. Live tests need a supported installed application and a separately bounded task authorization.

After installing a candidate, an explicitly authorized native check can run `test/native-permissions-live.mjs` with `DSH_LIVE_VERIFY=1`. It uses the latest installed snapshot, creates a disposable workspace and new Desktop conversation, and makes two bounded model turns. It writes its private evidence outside the public tree. It never runs in npm test or GitHub CI. Review that evidence and observe the frontend separately; a model's completed message alone is insufficient.

## 中文

先从研发仓生成白名单公开目录，保留原研发历史；公开目录单独初始化Git，再推送。不要把个人验收资料或运行状态加入公开提交。源码包需安装依赖并构建，bundle包已含构建产物，可直接运行setup与安装器。两种包都不包含Node.js、Codex、DeepSeek Harness、账号或聊天记录。

推送只触发机器测试，不会自动发布Release，也不会调用付费模型。
