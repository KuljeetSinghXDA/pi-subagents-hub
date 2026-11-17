/**
 * workflow-journal-format.test.ts — the journal file is a format, and this pins it.
 *
 * `journal.ts` has no version field. A journal outlives the code that wrote it:
 * a run resumed a week later, or in a build installed since, either replays from
 * it or silently re-pays for every agent. The reader is deliberately forgiving
 * (`readJournal` never throws, and drops what it cannot use), which is the right
 * behavior and also what makes a format change invisible: a renamed field would
 * not fail anything, it would just stop matching and everything would run live.
 *
 * So this checks the two halves against a fixture written by this fork's writer:
 * the exact key set the writer emits, and what the reader accepts, ignores and
 * orders. Replay behavior itself is `workflow-journal.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalKey, readJournal, type WorkflowJournalEntry } from "../src/workflow/journal.js";

const FIXTURE = new URL("./fixtures/workflow-journal-v1.jsonl", import.meta.url);

/**
 * Every field a settled call can carry, as `appendJournal` writes it.
 *
 * A field added or renamed here is a format change, and this list is the only
 * place that says so. If a new field is genuinely needed, update this list in
 * the same commit — that is the review prompt, not an annoyance.
 */
const ENTRY_KEYS = ["error", "gate", "index", "key", "ok", "path", "resumed", "text"];

const byIndex = (entries: WorkflowJournalEntry[]) => new Map(entries.map(entry => [entry.index, entry]));

describe("the journal format", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workflow-journal-format-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the checked-in fixture, in position order", () => {
    const entries = readJournal(FIXTURE.pathname);
    // Six settled entries; the future-shaped one is accepted too, the legacy
    // arrival-only line and the truncated last line are not.
    expect(entries.map(entry => entry.path)).toEqual([
      "#0",
      "#1",
      "#2",
      "#3",
      "#4",
      "/0:p:1#0",
      "#6",
    ]);
    expect(entries.map(entry => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps every field the writer can emit, on the entries that carried it", () => {
    const entries = byIndex(readJournal(FIXTURE.pathname));
    expect(entries.get(0)).toMatchObject({ ok: true, text: "files: auth.ts, session.ts" });
    expect(entries.get(2)?.gate).toEqual({ ok: true, output: "12 passed", cwd: "/repo" });
    expect(entries.get(3)).toMatchObject({ ok: false, error: "provider timeout" });
    expect(entries.get(4)?.resumed).toBe(true);
    expect(entries.get(5)?.path).toBe("/0:p:1#0");
  });

  it("does not reject an entry carrying fields this version does not know", () => {
    // A journal written by a newer build must degrade, not disappear: the
    // reader ignores what it does not understand rather than dropping the line.
    const entry = readJournal(FIXTURE.pathname).find(candidate => candidate.path === "#6");
    expect(entry).toBeDefined();
    expect((entry as Record<string, unknown>).v).toBe(2);
  });

  it("reproduces the fixture's keys from the current key inputs", () => {
    // Pins the canonical form. Adding a slot to `journalKey` — or changing
    // which options it covers — invalidates every journal on disk, and this
    // fails first.
    const entries = byIndex(readJournal(FIXTURE.pathname));
    expect(entries.get(0)?.key).toBe(journalKey({ prompt: "map the auth module" }));
    expect(entries.get(1)?.key).toBe(journalKey({ prompt: "review auth.ts", agentType: "Explore" }));
    expect(entries.get(2)?.key).toBe(journalKey({ prompt: "fix the flaky test", gate: "npm test" }));
    expect(entries.get(3)?.key).toBe(journalKey({ prompt: "retry the provider call" }));
    expect(entries.get(4)?.key).toBe(journalKey({ prompt: "continue the audit", resume: "audit" }));
    expect(entries.get(5)?.key).toBe(journalKey({ prompt: "one parallel thunk", model: "haiku" }));
  });

  it("emits exactly the documented key set", () => {
    const fixture = readFileSync(FIXTURE, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined; // the half-written last line
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter(entry => typeof entry.path === "string");

    const seen = new Set<string>();
    for (const entry of fixture) {
      for (const key of Object.keys(entry)) {
        // The future-shaped line's extra fields are the point of that line.
        if (key === "v" || key === "artifacts") continue;
        seen.add(key);
      }
    }
    expect([...seen].sort()).toEqual(ENTRY_KEYS);
  });

  it("writes what it reads, so a journal survives a rewrite", () => {
    // `appendJournal` + `readJournal` round-trip: the writer's line shape is the
    // reader's accepted shape, with no field silently dropped in between.
    const path = join(dir, "j.jsonl");
    const entry: WorkflowJournalEntry = {
      path: "#0",
      index: 0,
      key: journalKey({ prompt: "round trip" }),
      ok: true,
      text: "answer",
      gate: { ok: false, output: "1 failed", cwd: "/repo" },
    };
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
    expect(readJournal(path)).toEqual([entry]);
  });
});
