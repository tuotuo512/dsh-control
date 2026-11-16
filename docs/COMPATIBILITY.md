# Compatibility / 兼容范围

Version 0.7.0 is a Windows preview requiring Node.js 22+. The underlying native Desktop and SDK integration was exercised with DeepSeek Harness 0.2.2-rc.3 during local 0.5.0 validation; first-run/public packaging was checked in 0.6.0. The 0.7.0 project permissions, preflight, compact supervision and staging paths use model-free contract/package tests. Native full-access execution is not signed by those tests; ACP full access is refused pending verification. These checks do not claim a second physical computer or a new paid-model/UI acceptance run. Application buildCommit prefix `6b729` is descriptive, not an allowlist: setup checks the full supported installation identity. Other application builds, SDK versions and operating systems are unverified.

0.7.0为Windows预览版，要求Node22+。底层原生与SDK链路沿用0.5.0阶段对Harness/SDK 0.2.2-rc.3的实机证据，首次配置和公开包沿用0.6.0隔离核验。本版项目权限、预检、简短监控与候选预部署通过不调用模型的合同/打包测试；不代签真实完全访问执行，ACP完全访问仍待验证并明确拒绝。不冒充另一台实体电脑或新的付费模型/真人界面验收。buildCommit前缀6b729不是准入规则，setup按完整支持身份核验。其他系统/版本未验证。

The bridge consumes native Host Workspace Registry and Session Controller services through a bounded local plugin. Internal APIs may change across Harness releases. A source build, installed snapshot, loaded Host plugin, MCP discovery, real model execution and visible UI are separate checks. Do not infer compatibility from matching version labels alone or bypass fingerprint rejection.

Desktop is the default new-conversation route. SDK and ACP are explicit alternatives, not fallbacks. ACP has one-shot permission requests but no blocking user-question operation. A working installation and existing tasks are not upgraded or restarted by publishing this source release.

Fixture tests verify local contracts; real integrations require a compatible installed application, model access and explicit bounded authorization. No private machine verification records or credentials are distributed. Human acceptance is never inferred from test counts.
