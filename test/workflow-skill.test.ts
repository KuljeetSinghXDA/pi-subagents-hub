/**
 * workflow-skill.test.ts — the authoring reference ships as a skill.
 *
 * `workflowReference` decides where the script-writing reference lives: in the
 * `SubagentWorkflow` description (default), or in `skills/workflow-authoring/SKILL.md`
 * with the description pointing at it. The text must live in exactly one of the
 * two — duplicating it costs the tokens the setting exists to save, and a skill
 * whose body drifted from the description would teach a different API.
 *
 * `workflow-tool-description.test.ts` pins what the reference says; this pins
 * where it is and that the pair stays exclusive.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkflowReference,
  pointerWorkflowReference,
  setWorkflowReference,
  WORKFLOW_SKILL_PATH,
  workflowToolDescription,
} from "../src/workflow/tool-description.js";

const readSkill = () => readFileSync(WORKFLOW_SKILL_PATH, "utf8");

/** The YAML frontmatter as flat `key: value` pairs, and the body after it. */
function parseSkill(text: string): { front: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  const front: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (pair) front[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
  }
  return { front, body: match[2] };
}

/** Sentences that open a reference section — each must live in exactly one place. */
const REFERENCE_MARKERS = [
  "A workflow structures work across many agents",
  "the right move is often **hybrid**",
  "Script body hooks:",
  "Any agent() option not listed above is rejected by name",
  "Scripts are plain JavaScript, NOT TypeScript",
  "DEFAULT TO pipeline().",
  "A barrier is NOT justified by:",
  "Loop-until-count pattern",
  "Gate-and-retry pattern",
  "Quality patterns —",
  "These patterns aren't exhaustive",
  "## Resume",
];

afterEach(() => {
  setWorkflowReference("inline");
});

describe("the workflow-authoring skill", () => {
  it("defaults to inline, so a fresh session reads the reference before calling", () => {
    expect(getWorkflowReference()).toBe("inline");
    expect(workflowToolDescription()).toContain("Script body hooks:");
  });

  it("exists where the package manifest declares it", () => {
    // Declared so pi lists it: a model asked whether it loaded the skill looks
    // in the skill list, not in a tool description.
    expect(existsSync(WORKFLOW_SKILL_PATH)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { pi?: { skills?: string[] } };
    expect(manifest.pi?.skills).toContain("./skills");
  });

  it("is named after its directory, as the skill spec requires", () => {
    expect(parseSkill(readSkill()).front.name).toBe("workflow-authoring");
  });

  it("carries the reference with no unresolved placeholders", () => {
    const { body } = parseSkill(readSkill());
    // Its own title, not part of the tool description's prose.
    expect(body.trimStart().startsWith("# Workflow authoring reference")).toBe(true);
    expect(body).toContain("A workflow structures work across many agents");
    expect(body).toContain("Script body hooks:");
    // `{{typeList}}` is resolved at registration in the tool description; a
    // static file has no registry to ask, so it must not carry the token.
    expect(body).not.toMatch(/\{\{\w+\}\}/);
  });

  it("is what the description points at in skill mode, and only then", () => {
    setWorkflowReference("skill");
    const description = workflowToolDescription();
    expect(description).toContain(pointerWorkflowReference);
    expect(description).toContain(WORKFLOW_SKILL_PATH);

    setWorkflowReference("inline");
    expect(workflowToolDescription()).not.toContain(pointerWorkflowReference);
  });

  it("keeps every reference section in exactly one of the two", () => {
    const skill = parseSkill(readSkill()).body;
    setWorkflowReference("skill");
    const pointer = workflowToolDescription();
    setWorkflowReference("inline");
    const inline = workflowToolDescription();

    for (const marker of REFERENCE_MARKERS) {
      const places = [inline.includes(marker), skill.includes(marker), pointer.includes(marker)];
      expect(places, `"${marker}" should be in the inline description and the skill`).toEqual([true, true, false]);
    }
  });

});
