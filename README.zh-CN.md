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

- 想把 **Google Gemini CLI 的额度 / 账号** 更稳定地接入 OpenClaw 的人
- 准备使用 **多个 auth profile / 多个账户额度**，并希望能更快捷切换的人
- 主要通过 **Telegram** 与 OpenClaw 聊天、而且经常用到 **群组和 topic** 的人，希望这些路由和投递逻辑更稳
- 需要让 **自定义 OpenAI 兼容提供商**（例如 TokenLab/sub2api）更接近 Codex / Responses 使用体验、少踩兼容坑的人

## CiwardClaw 增加了什么

下面这些是 `ciwardclaw-4.14` 这条 fork 分支上的主要增强点。

- ⚡ **Steer 模式与 `/refresh` 更可靠**：补了 Telegram / Discord 的 channel serialization 绕过、active-run steering，以及 replace-not-append 的 refresh 流程。
- 🛡️ **重启恢复与 typing 连续性更稳**：覆盖 gateway 重启恢复、`/new` 之后的 run 恢复，以及原生命令 typing 恢复。
- ❤️ **Heartbeat 路由保护**：让 forced session、configured session、thread/topic 投递保持一致。
- 🧭 **`/profiles` 使用体验增强**：加入 profile 绑定的 usage/status 行为。
- 🔐 **Gemini、Codex 和自定义提供商运行时加固**：包括 Codex profile login/switch、Gemini CLI OAuth / runtime 修复、显式优先 API key，以及 Responses 兼容和 Gemini quota window 分类修复。
- 🧯 **Fallback / status / cost 防护**：避免 false live-switch、zero-context fallback、CCA quota retry loop、compaction token 记账错误，以及 custom OpenAI cost 处理问题。
- 🖼️ **媒体与历史重放更正确**：把 inline `data:image/...;base64,...` 历史内容重放成真实图片输入，并补了 Telegram topic / final delivery 相关修复。

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
