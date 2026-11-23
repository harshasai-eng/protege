import type { NewItem } from "../../storage/runs.ts";

// Harness notes: developer messages Protege adds to the conversation

const runNotes = {
  interrupted:
    "The previous run was interrupted: Protege stopped unexpectedly or couldn't save its last turn. " +
    "Its last steps may be missing; check any files it was writing.",
} as const;

/** A pg:run_note item, as stored and as the model sees it */
export function runNote(kind: keyof typeof runNotes): NewItem {
  return {
    itemType: "pg:run_note",
    itemJson: { type: "message", role: "developer", content: `<run_note>${runNotes[kind]}</run_note>` },
  };
}