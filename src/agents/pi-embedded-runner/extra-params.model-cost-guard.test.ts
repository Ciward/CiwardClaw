import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type CapturedModel = Model<"openai-completions"> & {
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

function runCostGuardCase(params: {
  applyProvider: string;
  applyModelId: string;
  model: CapturedModel;
}) {
  let capturedModel: CapturedModel | undefined;
  const baseStreamFn: StreamFn = (model, _context, _options) => {
    capturedModel = model as CapturedModel;
    return {} as unknown as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);
  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {});
  return capturedModel;
}

describe("extra-params: runtime model cost guard", () => {
  it("injects zeroed cost object when model.cost is missing", () => {
    const captured = runCostGuardCase({
      applyProvider: "sdu-ai",
      applyModelId: "sdu-chat",
      model: {
        api: "openai-completions",
        provider: "sdu-ai",
        id: "sdu-chat",
      } as CapturedModel,
    });

    expect(captured?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("preserves existing cost values while backfilling missing fields", () => {
    const captured = runCostGuardCase({
      applyProvider: "sdu-ai",
      applyModelId: "sdu-chat",
      model: {
        api: "openai-completions",
        provider: "sdu-ai",
        id: "sdu-chat",
        cost: {
          input: 1.5,
          output: 4.2,
        },
      } as CapturedModel,
    });

    expect(captured?.cost).toEqual({
      input: 1.5,
      output: 4.2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
