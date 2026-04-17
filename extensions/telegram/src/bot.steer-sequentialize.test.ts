import { beforeEach, describe, expect, it } from "vitest";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  getLoadConfigMock,
  makeForumGroupMessageCtx,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = harness;
const {
  createTelegramBot: createTelegramBotBase,
  setTelegramBotRuntimeForTest,
  getTelegramSequentialKey,
} = await import("./bot.js");
const activeDispatches = await import("./active-dispatches.js");

let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();

describe("Telegram steer sequentialize", () => {
  beforeEach(() => {
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("uses a steer-specific sequentialize key when a Telegram dispatch is already active", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      messages: {
        queue: {
          mode: "steer",
        },
      },
    });

    createTelegramBot({ token: "tok" });

    const ctx = makeForumGroupMessageCtx({ threadId: 99, text: "hello" }) as unknown as Parameters<
      typeof getTelegramSequentialKey
    >[0];
    const baseKey = getTelegramSequentialKey(ctx);
    expect(harness.sequentializeKey?.(ctx)).toBe(baseKey);

    activeDispatches.markTelegramDispatchActive(baseKey);
    try {
      const steerKey = harness.sequentializeKey?.(ctx);
      expect(typeof steerKey).toBe("string");
      expect(steerKey?.startsWith(`${baseKey}:steer:`)).toBe(true);
    } finally {
      activeDispatches.clearTelegramDispatchActive(baseKey);
    }
  });
});
