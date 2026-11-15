/**
 * branch-selection.ts — The model and thinking level a saved session branch records.
 *
 * `createAgentSession` restores them only when the caller passes no explicit
 * values, and the durable harness needs the same answer before that session
 * exists, so both read the saved transcript through these helpers.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EffectiveThinkingLevel } from "../types.js";

interface ModelRef {
  provider: string;
  modelId: string;
}

/** A `thinking_level_change` entry holds a plain string; only these are usable as a session level. */
const THINKING_LEVEL_NAMES: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function lastModelChange(branch: readonly SessionEntry[]): (ModelRef & { index: number }) | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "model_change") {
      return { index: i, provider: entry.provider, modelId: entry.modelId };
    }
  }
  return undefined;
}

/** The physical model that answered most recently after `afterIndex`. */
function lastResponseModel(branch: readonly SessionEntry[], afterIndex: number): ModelRef | undefined {
  for (let i = branch.length - 1; i > afterIndex; i--) {
    const entry = branch[i];
    if (
      entry?.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.api !== "pi-virtual" &&
      entry.message.provider &&
      entry.message.model
    ) {
      return { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return undefined;
}

function lookup(ref: ModelRef | undefined, registry: ModelRegistry): Model<any> | undefined {
  return ref === undefined ? undefined : registry.find(ref.provider, ref.modelId);
}

/**
 * The model a reopened session ran on: a virtual `model_change` holds until the
 * next one, because assistant rows name the physical model it routed to;
 * otherwise the latest physical response wins, as in sessions without virtual
 * models. A selection whose model is no longer registered does not hold.
 */
export function restoreBranchModel(
  branch: readonly SessionEntry[],
  registry: ModelRegistry,
): Model<any> | undefined {
  const change = lastModelChange(branch);
  const changeModel = lookup(change, registry);
  if (changeModel?.api === "pi-virtual") return changeModel;
  return lookup(lastResponseModel(branch, change?.index ?? -1), registry) ?? changeModel;
}

/** The latest thinking level a reopened session ran on. */
export function restoreBranchThinkingLevel(branch: readonly SessionEntry[]): EffectiveThinkingLevel | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "thinking_level_change" && THINKING_LEVEL_NAMES.includes(entry.thinkingLevel)) {
      return entry.thinkingLevel as EffectiveThinkingLevel;
    }
  }
  return undefined;
}
