import { describe, expect, it } from "vitest";
import { type MainPromptValues, mainPrompt } from "../prompts/main.ts";
import { modeNote, reminder, reminderLines, runNote } from "../prompts/notes.ts";

const values: MainPromptValues = {
  workflow: { name: "Expense audit", description: "Check each month's expenses against the receipts." },
  interactive: true,
  webSearch: true,
  skills: "- receipts: How to match receipts to expense lines.",
  cwd: "/Users/sam/audits",
  os: "macOS",
  bash: { version: "5.2", is32: false },
  runtimeSummary: "Python 3.13 with pandas, openpyxl, pdfplumber",
  date: "Monday, 23 November 2026",
};

/** Every variant renders cleanly: no gaps left by a section that's off */
function expectClean(text: string) {
  expect(text).not.toMatch(/undefined|\[object Object\]|\$\{/);
  expect(text).not.toMatch(/\n{3,}/); // no double blank lines
  expect(text).not.toMatch(/ +\n/); // no trailing spaces
}

describe("mainPrompt", () => {
  it("renders an interactive session with every value in place", () => {
    const text = mainPrompt(values);
    expectClean(text);
    expect(text).toContain('<workflow name="Expense audit">\nCheck each month');
    expect(text).toContain("unless you're blocked or the mode stops you.");
    expect(text).toContain("Ask with ask_user");
    expect(text).toContain("## Modes");
    expect(text).not.toContain("## Working alone");
    expect(text).toContain("- receipts: How to match");
    expect(text).toContain("- System: macOS; shell: bash 5.2\n");
    expect(text).toMatch(/- Session started: Monday, 23 November 2026$/);
  });

  it("renders a worker: no questions, no modes, working alone", () => {
    const text = mainPrompt({ ...values, interactive: false });
    expectClean(text);
    expect(text).toContain("unless you're blocked. Don't guess");
    expect(text).not.toMatch(/ask_user|propose_plan|## Modes|After a plan is approved/);
    expect(text).toContain("## Working alone");
  });

  it("mentions web search only when it's on", () => {
    const on = mainPrompt(values);
    const off = mainPrompt({ ...values, webSearch: false });
    expectClean(off);
    expect(on.match(/web search|search the web/g)).toHaveLength(3);
    expect(off).not.toMatch(/web search|search the web/);
    expect(off).toContain("run commands in a sandbox, load skills");
  });

  it("warns about macOS's old bash", () => {
    const text = mainPrompt({ ...values, bash: { version: "3.2.57", is32: true } });
    expect(text).toContain("bash 3.2.57 (macOS's bash 3.2: avoid bash 4 features");
  });

  it("renders with no skills yet", () => {
    expectClean(mainPrompt({ ...values, skills: "" }));
  });
});

describe("harness notes", () => {
  it("wraps each note in its tag, as a developer message", () => {
    expect(runNote("cancelled")).toEqual({
      itemType: "pg:run_note",
      itemJson: {
        type: "message",
        role: "developer",
        content: expect.stringMatching(/^<run_note>The previous run was stopped .*<\/run_note>$/),
      },
    });
    expect(modeNote("plan").itemJson).toMatchObject({ content: expect.stringContaining("<mode>The session is in Plan mode") });
  });

  it("puts everything due before a turn in one reminder", () => {
    const item = reminder(["Tasks: 1 done", reminderLines.twoTurnsLeft]);
    expect(item.itemType).toBe("pg:reminder");
    expect(item.itemJson).toMatchObject({ content: `<reminder>Tasks: 1 done\n${reminderLines.twoTurnsLeft}</reminder>` });
  });
});