# 首次安装

自定义状态目录时，setup与每条安装器命令都要使用相同的`--home`，或为这些命令设置`DSH_CONTROL_HOME`。安装器会将状态目录写入MCP注册，下一次Codex启动无需依赖当前终端环境。检查该安装可用`npm run doctor -- --home <目录>`；`--dsh-home`、`--profile`、`--codex-root`等覆盖参数也须保持一致。

[English](INSTALL.md) · [中文首页](../README.zh-CN.md)

准备 Windows、Node.js 22+ 和已安装的兼容 DeepSeek Harness 0.2.2-rc.3；在 Harness 本身完成登录与模型配置。其他构建和系统未验证，见[兼容范围](COMPATIBILITY.md)。取得源码checkout或完整源码发布包，在其根目录开终端；预期GitHub仓库为tuotuo512/dsh-control，不表示已创建或推送。

```powershell
npm ci
npm run build
npm run setup -- --plan
```

setup默认只读。核对识别出的软件、profile、模型与backend。可用参数：--executable、--home、--dsh-home、--profile、--provider、--model、--reasoning-effort、--backend、--max-parallel；backend默认desktop。不要在参数中放凭据。它只读取已有账号/模型配置，不复制凭据，拒绝未知兼容构建与覆盖已有配置。

```powershell
npm run setup -- --write
npm run install:plugin -- plan
npm run install:plugin -- apply
npm run install:plugin -- verify
node src/cli.mjs doctor
node src/cli.mjs desktop_workspaces
```

apply必须先setup；任务仍运行或租约未释放时拒绝，不要为安装打断它们。本方案安装本机MCP桥接与配套技能/原生插件，单勾技能不能接通；未宣称GitHub远程市场安装通过。

当前Codex聊天未加载新工具时，用同一实现的CLI。checkout入口为node src/cli.mjs；已安装部署通过doctor.stateDirectory下最新安装receipt的serverDir定位cli.mjs，不随意选旧digest目录。

首次派工用小范围只读任务。先列工作区，再以选中项目的规范cwd和workspaceId，通过UTF-8 JSON传给start。用status/result跟踪，另核前端可见性；清单存在不等于已观察到界面。未知提交不换requestId重放。

更新先plan，等已有任务结束再apply并verify。卸载用npm run install:plugin -- uninstall，保留runs与报告。已有配置不通过首次setup重置；用doctor诊断，不删状态、不复制凭据、不安装另一套Harness或重启Host绕过问题。
