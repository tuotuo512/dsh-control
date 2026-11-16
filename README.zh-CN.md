# DSH Control

[English](README.md) · [首次安装](docs/INSTALL.zh-CN.md) · [兼容范围](docs/COMPATIBILITY.md) · [技术合同](docs/contract.md)

让 Codex 指挥本机已安装的 DeepSeek Harness：Codex 保持规划、范围与验收，DeepSeek 执行明确子任务。Desktop 原生对话在前端可见，MCP 断连后仍可读取持久报告。

**0.7.0 Windows 预览版，Node.js 22+，MIT。** 既有桌面/SDK 链路验证过 Harness 0.2.2-rc.3，新权限与快捷流程通过不调用模型的测试；真实完全访问执行、其他软件构建与系统未验证。源码与版本：[tuotuo512/dsh-control](https://github.com/tuotuo512/dsh-control)。

## 从源码安装

在源码 checkout 或完整源码发布包中执行；完整说明见[安装教程](docs/INSTALL.zh-CN.md)。

```powershell
npm ci
npm run build
npm run setup -- --plan
npm run setup -- --write
npm run install:plugin -- plan
npm run install:plugin -- apply
npm run install:plugin -- verify
```

npm ci 只安装依赖，不安装插件。setup 默认只读，检查本机已有软件及账号/模型配置，拒绝未知构建与覆盖已有配置，不复制供应商凭据。先看计划再写入。插件需要安装器连接本机 MCP 桥接；仅在市场勾选技能不等于接通 DeepSeek。未宣称 GitHub 远程市场安装已经验证。

## 先选项目，再选对话

13个工具及完整参数见[操作参考](skill/references/operations.md)。先列原生工作区，再优先复用该项目相关对话；明确要求或独立工作确需时才新开，忙碌、断连、未知不构成另开替代许可。Desktop start 仍必填 cwd，可带 workspaceId，两者规范路径必须一致；未知id拒绝，不新建替代。

跨天先读 doctor.bindingsPath 的项目/对话关系笔记，再实时核存在、归档与任务租约。笔记不记聊天内容、进展、待办或全局默认。明确归档/不存在才移除关联并停止发送，查询失败保留。已有任务保留原通道，不为默认偏好中断或重复派发。

默认新任务为前端可见 Desktop、只读；SDK/ACP需要明确选择，失败不静默换通道。写任务显式授予 workspace-write 与 ownedPaths。接收成功、回合完成与任务验收分别判断，未知结果不自动重放。

## 维护与公开导出

新增 `dsh_workspace_policy` 按项目保存权限、`dsh_preflight` 零聊天/零模型开工检查，共15个工具。日常 list/status/wait 可传 `compact:true` 缩短回执；简短派工消息引用任务文档。完全访问由作者为准确项目明确保存，未知项目仍只读，已有会话保持原权限；操作见[参考](skill/references/operations.md)。

安装器支持 plan/apply/verify/uninstall；apply要求先setup且受管任务运行时拒绝。卸载保留报告与历史，不重启Desktop Host。源码变更不会自动更新已有安装。

```powershell
npm test
npm run release:check
npm run release:export -- --out ../dsh-control-public
```

公开目录采用源码白名单，不含研发.git、个人验收记录、状态或node_modules。提供源码包、预构建bundle和SHA256校验；见[发布说明](docs/RELEASING.md)，由操作者自行推送和发布。机器夹具、实际Harness联验与人类验收分别记账。
