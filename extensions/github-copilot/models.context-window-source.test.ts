import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { fetchCopilotModelCatalog } from "./models.js";

describe("native context window provenance", () => {
  async function mapLimits(limits: Record<string, unknown>) {
    const [model] = await fetchCopilotModelCatalog({
      copilotApiToken: "fixture-token",
      baseUrl: "https://fixture.test",
      fetchImpl: async () =>
        Response.json({
          data: [{ id: "account-model", capabilities: { type: "chat", limits } }],
        }),
    });
    return expectDefined(model, "mapped account model");
  }

  it("keeps a missing native window replaceable instead of fabricating a 128k ceiling", async () => {
    const model = await mapLimits({ max_prompt_tokens: 777_000, max_output_tokens: 128_000 });
    // The real prompt limit survives and the estimate cannot clamp it.
    expect(model.contextTokens).toBe(777_000);
    expect(model.contextWindow).toBeUndefined();
    expect(model).not.toHaveProperty("contextWindowSource");
    expect(model.maxTokens).toBe(128_000);
  });

  it.each([
    ["absent", {}],
    ["zero", { max_context_window_tokens: 0 }],
    ["negative", { max_context_window_tokens: -1 }],
    ["non-numeric", { max_context_window_tokens: "400000" }],
    ["fractional", { max_context_window_tokens: 1.5 }],
  ])("leaves an %s native window unknown in catalog metadata", async (_name, limits) => {
    const model = await mapLimits(limits);
    expect(model.contextWindow).toBeUndefined();
    expect(model).not.toHaveProperty("contextWindowSource");
    expect(model.contextTokens).toBeUndefined();
  });

  it("preserves a genuinely reported native 128k window as a real constraint", async () => {
    const model = await mapLimits({
      max_context_window_tokens: 128_000,
      max_prompt_tokens: 777_000,
    });
    // Provenance is reported by the provider, never inferred from the value 128k.
    expect(model.contextWindow).toBe(128_000);
    expect(model).not.toHaveProperty("contextWindowSource");
    expect(model.contextTokens).toBe(777_000);
  });
});
