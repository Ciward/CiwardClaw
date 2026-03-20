import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { TypingPolicy } from "../types.js";
import type { TypingController } from "./typing.js";

export type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
  typingPolicy?: TypingPolicy;
  suppressTyping?: boolean;
};

export const DEFAULT_GROUP_TYPING_MODE: TypingMode = "message";
export const MESSAGE_MODE_TYPING_FALLBACK_DELAY_MS = 1_500;

export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
  typingPolicy,
  suppressTyping,
}: TypingModeContext): TypingMode {
  if (
    isHeartbeat ||
    typingPolicy === "heartbeat" ||
    typingPolicy === "system_event" ||
    typingPolicy === "internal_webchat" ||
    suppressTyping
  ) {
    return "never";
  }
  if (configured) {
    return configured;
  }
  if (!isGroupChat || wasMentioned) {
    return "instant";
  }
  return DEFAULT_GROUP_TYPING_MODE;
}

export type TypingSignaler = {
  mode: TypingMode;
  shouldStartImmediately: boolean;
  shouldStartOnMessageStart: boolean;
  shouldStartOnText: boolean;
  shouldStartOnReasoning: boolean;
  signalRunStart: () => Promise<void>;
  signalMessageStart: () => Promise<void>;
  signalTextDelta: (text?: string) => Promise<void>;
  signalReasoningDelta: () => Promise<void>;
  signalToolStart: () => Promise<void>;
};

export function createTypingSignaler(params: {
  typing: TypingController;
  mode: TypingMode;
  isHeartbeat: boolean;
}): TypingSignaler {
  const { typing, mode, isHeartbeat } = params;
  const shouldStartImmediately = mode === "instant";
  const shouldStartOnMessageStart = mode === "message";
  const shouldStartOnText = mode === "message" || mode === "instant";
  const shouldStartOnReasoning = mode === "thinking";
  const disabled = isHeartbeat || mode === "never";
  let hasRenderableText = false;
  let delayedMessageStartTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDelayedMessageStart = () => {
    if (!delayedMessageStartTimer) {
      return;
    }
    clearTimeout(delayedMessageStartTimer);
    delayedMessageStartTimer = undefined;
  };

  const scheduleDelayedMessageStart = () => {
    if (disabled || !shouldStartOnMessageStart) {
      return;
    }
    clearDelayedMessageStart();
    delayedMessageStartTimer = setTimeout(() => {
      delayedMessageStartTimer = undefined;
      if (typing.isActive()) {
        return;
      }
      void typing.startTypingLoop().catch((err) => {
        logVerbose(`typing delayed message-start failed: ${String(err)}`);
      });
    }, MESSAGE_MODE_TYPING_FALLBACK_DELAY_MS);
    delayedMessageStartTimer.unref?.();
  };

  const isRenderableText = (text?: string): boolean => {
    const trimmed = text?.trim();
    if (!trimmed) {
      return false;
    }
    return !isSilentReplyText(trimmed, SILENT_REPLY_TOKEN);
  };

  const signalRunStart = async () => {
    if (disabled) {
      return;
    }
    if (shouldStartImmediately) {
      clearDelayedMessageStart();
      await typing.startTypingLoop();
      return;
    }
    scheduleDelayedMessageStart();
  };

  const signalMessageStart = async () => {
    if (disabled || !shouldStartOnMessageStart) {
      return;
    }
    if (!hasRenderableText) {
      return;
    }
    clearDelayedMessageStart();
    await typing.startTypingLoop();
  };

  const signalTextDelta = async (text?: string) => {
    if (disabled) {
      return;
    }
    const renderable = isRenderableText(text);
    if (renderable) {
      hasRenderableText = true;
    } else if (text?.trim()) {
      return;
    }
    if (shouldStartOnText) {
      clearDelayedMessageStart();
      await typing.startTypingOnText(text);
      return;
    }
    if (shouldStartOnReasoning) {
      clearDelayedMessageStart();
      if (!typing.isActive()) {
        await typing.startTypingLoop();
      }
      typing.refreshTypingTtl();
    }
  };

  const signalReasoningDelta = async () => {
    if (disabled || !shouldStartOnReasoning) {
      return;
    }
    if (!hasRenderableText) {
      return;
    }
    clearDelayedMessageStart();
    await typing.startTypingLoop();
    typing.refreshTypingTtl();
  };

  const signalToolStart = async () => {
    if (disabled) {
      return;
    }
    clearDelayedMessageStart();
    // Start typing as soon as tools begin executing, even before the first text delta.
    if (!typing.isActive()) {
      await typing.startTypingLoop();
      typing.refreshTypingTtl();
      return;
    }
    // Keep typing indicator alive during tool execution.
    typing.refreshTypingTtl();
  };

  return {
    mode,
    shouldStartImmediately,
    shouldStartOnMessageStart,
    shouldStartOnText,
    shouldStartOnReasoning,
    signalRunStart,
    signalMessageStart,
    signalTextDelta,
    signalReasoningDelta,
    signalToolStart,
  };
}
