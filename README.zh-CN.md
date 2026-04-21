# 🦞 CiwardClaw

[English README](./README.md)

这是一个基于 [OpenClaw](https://github.com/openclaw/openclaw) 的个人 fork，重点放在 CiwardClaw 自己长期在用的稳定性修复、提供商兼容性补丁，以及可直接安装的发布包上。

## 安装 CiwardClaw

### 一键安装最新版本

```bash
npm install -g https://github.com/Ciward/CiwardClaw/releases/latest/download/openclaw-latest.tgz
```

## 适用人群

CiwardClaw 特别适合这些人：

- 想把 **Google Gemini CLI 的额度 / 账号** 更稳定地接入 OpenClaw 的人（`89b1bd2705`, `92af4fc86d`, `9d09fc7cad`, `a65f43da68`, `a10b3e9f03`, `dc7d8d45c2`）
- 准备使用 **多个 auth profile / 多个账户额度**，并希望能更快捷切换的人（`2e704a2490`, `4cd5ec67ca`, `32816703a7`, `89b1bd2705`, `6d5e55867c`, `beb9822f4b`）
- 主要通过 **Telegram** 与 OpenClaw 聊天、而且经常用到 **群组和 topic** 的人，希望这些路由和投递逻辑更稳（`fcac1dde00`, `9aaac52c75`, `bf80723dde`, `7fb8d606b5`, `c12ae5a4fe`, `5c8a74f2c5`）
- 需要让 **自定义 OpenAI 兼容提供商**（例如 TokenLab/sub2api）更接近 Codex / Responses 使用体验、少踩兼容坑的人（`a7e7d897d9`, `2f225ae047`, `6d5e55867c`, `beb9822f4b`）

## CiwardClaw 增加了什么

下面每条都对应 `ciwardclaw-4.14` 分支里已经存在的提交。

- ⚡ **Steer 模式与 `/refresh` 更可靠**：补了 Telegram / Discord 的 channel serialization 绕过、active-run steering，以及 replace-not-append 的 refresh 流程（`fcac1dde00`, `6aa8860343`, `f8d30243c8`）。
- 🛡️ **重启恢复与 typing 连续性更稳**：覆盖 gateway 重启恢复、`/new` 之后的 run 恢复，以及原生命令 typing 恢复（`7c124e9c6c`, `15e02608f3`, `8bd5271f31`, `4a993bf1af`, `9aaac52c75`, `bf80723dde`）。
- ❤️ **Heartbeat 路由保护**：让 forced session、configured session、thread/topic 投递保持一致（`7fb8d606b5`, `292b2df52b`, `a8ea2906e0`）。
- 🧭 **`/profiles` 使用体验增强**：加入 profile 绑定的 usage/status 行为（`2e704a2490`, `4cd5ec67ca`, `32816703a7`）。
- 🔐 **Gemini、Codex 和自定义提供商运行时加固**：包括 Codex profile login/switch、Gemini CLI OAuth / runtime 修复、显式优先 API key，以及 Responses 兼容和 Gemini quota window 分类修复（`89b1bd2705`, `92af4fc86d`, `9d09fc7cad`, `a65f43da68`, `a10b3e9f03`, `6d5e55867c`, `beb9822f4b`, `a7e7d897d9`, `2f225ae047`, `dc7d8d45c2`）。
- 🧯 **Fallback / status / cost 防护**：避免 false live-switch、zero-context fallback、CCA quota retry loop、compaction token 记账错误，以及 custom OpenAI cost 处理问题（`01148a23a8`, `63c42ffaef`, `1b8f4a2f00`, `94263afc2a`, `d640915829`, `ae38972fd7`, `ad9a588fa3`）。
- 🖼️ **媒体与历史重放更正确**：把 inline `data:image/...;base64,...` 历史内容重放成真实图片输入，并补了 Telegram topic / final delivery 相关修复（`8ae14d830d`, `c12ae5a4fe`, `5c8a74f2c5`）。

## 分支与发布

- 默认分支：`ciwardclaw-4.14`
- 当前分支版本：`2026.4.14`
- 最新 fork tag：[`v2026.4.14`](https://github.com/Ciward/CiwardClaw/releases/tag/v2026.4.14)
- 上游基线：[`openclaw/openclaw`](https://github.com/openclaw/openclaw) `main`

## 上游文档

核心安装与使用文档仍然以 upstream 为准：

- Docs: https://docs.openclaw.ai
- Upstream README: https://github.com/openclaw/openclaw

## Maintainer

- [@Ciward](https://github.com/Ciward)
