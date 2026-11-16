# Compatibility / 兼容范围

Version 0.6.0 is a Windows preview requiring Node.js 22+. The underlying native Desktop and SDK integration was exercised with DeepSeek Harness 0.2.2-rc.3 during local 0.5.0 validation. The 0.6.0 first-run and public-package checks use isolated installation profiles; they do not claim a second physical computer or a new paid-model/UI acceptance run. Application buildCommit prefix `6b729` is descriptive, not an allowlist: setup checks the full supported installation identity. Other application builds, SDK versions and operating systems are unverified.

0.6.0为Windows预览版，要求Node22+。底层原生与SDK链路沿用0.5.0阶段对Harness/SDK 0.2.2-rc.3的实机证据；0.6.0首次配置和公开包使用隔离安装环境核验，不冒充另一台实体电脑或新的付费模型/真人界面验收。buildCommit前缀6b729不是准入规则，setup按完整支持身份核验。其他系统/版本未验证。

The bridge consumes native Host Workspace Registry and Session Controller services through a bounded local plugin. Internal APIs may change across Harness releases. A source build, installed snapshot, loaded Host plugin, MCP discovery, real model execution and visible UI are separate checks. Do not infer compatibility from matching version labels alone or bypass fingerprint rejection.

Desktop is the default new-conversation route. SDK and ACP are explicit alternatives, not fallbacks. ACP has one-shot permission requests but no blocking user-question operation. A working installation and existing tasks are not upgraded or restarted by publishing this source release.

Fixture tests verify local contracts; real integrations require a compatible installed application, model access and explicit bounded authorization. No private machine verification records or credentials are distributed. Human acceptance is never inferred from test counts.
