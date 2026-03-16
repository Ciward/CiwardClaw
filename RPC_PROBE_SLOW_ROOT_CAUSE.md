# Gateway 重启慢（`RPC probe: ok`）排查报告

## 背景

现象是本地 `openclaw gateway restart --json` / `gateway status --json --no-probe` 经常卡到约 175~200 秒，表现为“看起来在等 RPC probe”。

## 结论（先说重点）

问题有两层：

1. **命令慢（主因）**：CLI 启动时会在 `src/agents/context.ts` 触发 eager context-window warmup，间接进入 provider/plugin discovery（包括插件 provider 的模型发现），导致 `gateway status/restart` 这类命令在**真正执行前**就被拖慢到分钟级。
2. **重启路径慢（次因）**：在 launchd 标记 `immediate reason = inefficient` 时，走 `kickstart -k` 全进程重启会触发明显退避，重启耗时可能被放大。

也就是说：之前观测到的“RPC probe 慢”，大量时间其实不在 probe 本身，而在命令启动阶段。

## 关键证据

- 时间采样显示：命令前段出现插件注册日志（如 `feishu_doc`）并长时间停顿，最终才输出 status/restart JSON。
- 带堆栈的 trace 证实调用链：
  - `src/agents/context.ts` 的 eager warmup → `ensureOpenClawModelsJson` / provider discovery
  - 进而触发 `resolvePluginProviders` → `loadOpenClawPlugins`（可见 Feishu 工具注册日志）
- 在不改重启逻辑、只绕开该 warmup 时，`gateway status/restart` 立即恢复到秒级。

## 本次保留的修改（有用）

### A) CLI 启动性能修复（本次主修复）

- `src/agents/context.ts`
  - 对 `gateway` 子命令默认跳过 eager warmup，仅保留 `gateway run` 不跳过。
- `src/agents/context.test.ts`
  - 新增测试覆盖：
    - `gateway status/restart` 应跳过；
    - `gateway run` 应保留 warmup。

### B) launchd 重启路径稳态修复（前面排查阶段已验证有效）

- `src/daemon/launchd.ts` / `src/daemon/launchd.test.ts`
  - 解析 `launchctl print` 的 `immediate reason`。
  - 当 reason 为 `inefficient` 且 PID 可验证时，优先发 `SIGUSR1` 走进程内重启，失败再回退到原流程。

- `src/infra/gateway-process-argv.ts` / `src/infra/gateway-process-argv.test.ts`
  - 允许 `openclaw-gateway` 单 token argv 形态通过验证（macOS/launchd 场景需要）。

- `src/cli/gateway-cli/run-loop.ts` / `src/cli/gateway-cli/run-loop.test.ts`
  - launchd 管理下 SIGUSR1 重启强制走 in-process 路径。
  - 管理态进程加长 lock 获取等待，减少重启交叠时的假失败。

## 已丢弃的修改（无必要）

- 已回退：
  - `src/gateway/server-close.ts`
  - `src/gateway/server.impl.ts`

这两处只用于额外 shutdown 计时日志，不是根因修复所必需。

## 验证结果

- 测试通过：
  - `src/agents/context.test.ts`
  - `src/cli/gateway-cli/run-loop.test.ts`
  - `src/daemon/launchd.test.ts`
  - `src/infra/gateway-process-argv.test.ts`
  - `src/cli/daemon-cli/lifecycle.test.ts`
- 构建通过：`pnpm build`

性能对比（本地实测）：

- `gateway status --json --no-probe`：**~197s → ~3.2s**
- `gateway restart --json`：**~182s → ~2.3s**

## 本地安装替换

已执行本地覆盖安装（全局）：

- `npm install -g .`

并验证：

- `openclaw -v` 正常
- `openclaw gateway status --json --no-probe` 为秒级返回
