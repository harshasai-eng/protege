import type { Config } from "../../config/settings.ts";
import type { EndReason, NewItem } from "../../storage/runs.ts";

// Harness notes: short developer messages Protege adds after the history, each in
// its own tag, only when due. Wording from the Prompts doc

// One for every way a run can end early. The compiler checks none is missing
const runNotes: Record<Exclude<EndReason, "completed">, string> = {
  max_turns: "The previous run reached its turn limit; its final message says what was left to do.",
  cancelled:
    "The previous run was stopped before it finished. Tool calls that were running were stopped; " +
    "check any files they were writing.",
  output_truncated:
    "The previous run ended because a response ran past the output limit and was discarded. " +
    "Work in smaller steps, for example writing a long file in parts.",
  content_filtered: "The previous run ended because the provider's content filter blocked a response.",
  transient_exhausted:
    "The previous run ended because the model provider kept failing (rate limits or server errors) " +
    "after several retries. Pick up where it stopped.",
  non_retryable:
    "The previous run ended because the model provider refused a request (for example, an invalid key " +
    "or an unknown model). Pick up where it stopped.",
  interrupted:
    "The previous run was interrupted: Protege stopped unexpectedly or couldn't save its last turn. " +
    "Its last steps may be missing; check any files it was writing.",
  // Kept for the record: a worker's session closes with time_limit, any session with context_overflow
  time_limit: "The run reached its time limit and was stopped.",
  context_overflow:
    "The previous run ended because the conversation was still too large for the model after summarizing. " +
    "Send a shorter message, or split the work into smaller requests.",
};

const modeNotes: Record<Config["permissions"]["defaultMode"], string> = {
  ask:
    "The session is in Ask mode: edits and commands that change things ask the user first. If they decline, " +
    "don't retry the same action: use their feedback if they gave any; otherwise find another way.",
  plan: "The session is in Plan mode: you can't change files, and commands run read-only.",
  auto: "The session is in Auto mode: edits and commands run without asking.",
};

// Wrap-up lines near the turn limit; the task line joins them in milestone 4
export const reminderLines = {
  twoTurnsLeft: "Two turns left in this run: finish the current step, then report where things stand.",
  lastTurn: "Last turn in this run, and tools are off: write your final message now, including what's left to do.",
} as const;

/** The note for a run that didn't complete, saved as the run's last item */
export function runNote(reason: Exclude<EndReason, "completed">): NewItem {
  return note("pg:run_note", "run_note", runNotes[reason]);
}

/** The mode note, written when the mode the model last saw differs */
export function modeNote(mode: Config["permissions"]["defaultMode"]): NewItem {
  return note("pg:mode", "mode", modeNotes[mode]);
}

/** One reminder for everything due before a turn: lines share one tag */
export function reminder(lines: string[]): NewItem {
  return note("pg:reminder", "reminder", lines.join("\n"));
}

// As stored and as the model sees it
function note(itemType: string, tag: string, text: string): NewItem {
  return { itemType, itemJson: { type: "message", role: "developer", content: `<${tag}>${text}</${tag}>` } };
}