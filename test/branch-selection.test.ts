import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { restoreBranchModel, restoreBranchThinkingLevel } from "../src/runner/branch-selection.js";

const parent = { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" };
const child = { provider: "deepseek", id: "deepseek-chat", api: "openai-completions" };
const virtual = { provider: "pool", id: "DeepSeek-Flash", api: "pi-virtual" };

function registry(models: readonly object[]): ModelRegistry {
  return {
    find: (provider, modelId) => models.find(m => (m as any).provider === provider && (m as any).id === modelId) as any,
  } as ModelRegistry;
}

const change = (model: { provider: string; id: string }) => ({ type: "model_change", provider: model.provider, modelId: model.id });
const response = (model: { provider: string; id: string; api: string }) =>
  ({ type: "message", message: { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [] } });
const thinking = (level: string) => ({ type: "thinking_level_change", thinkingLevel: level });

function branch(entries: object[]): SessionEntry[] {
  return entries as unknown as SessionEntry[];
}

describe("restoreBranchModel", () => {
  const models = registry([parent, child, virtual]);

  it("returns undefined for a branch with no selection", () => {
    expect(restoreBranchModel(branch([]), models)).toBeUndefined();
  });

  it("takes the latest model_change when no response follows it", () => {
    expect(restoreBranchModel(branch([change(child)]), models)).toBe(child);
  });

  it("prefers the physical model that answered after the last model_change", () => {
    expect(restoreBranchModel(branch([change(parent), response(child)]), models)).toBe(child);
  });

  it("keeps a virtual model_change even when responses name its physical route", () => {
    expect(restoreBranchModel(branch([change(virtual), response(child)]), models)).toBe(virtual);
  });

  it("does not resurrect an unregistered model and falls back to the last registered response", () => {
    const gone = { provider: "gone", id: "removed" };
    expect(restoreBranchModel(branch([change(gone), response(parent)]), models)).toBe(parent);
    expect(restoreBranchModel(branch([change(gone)]), models)).toBeUndefined();
  });
});

describe("restoreBranchThinkingLevel", () => {
  it("returns the latest recorded level", () => {
    expect(restoreBranchThinkingLevel(branch([thinking("low"), thinking("max")]))).toBe("max");
  });

  it("ignores levels a session cannot hold", () => {
    expect(restoreBranchThinkingLevel(branch([thinking("high"), thinking("bogus")]))).toBe("high");
    expect(restoreBranchThinkingLevel(branch([thinking("bogus")]))).toBeUndefined();
  });
});
