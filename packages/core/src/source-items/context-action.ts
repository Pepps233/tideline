import type { ContextAction, SourceLabel } from "../types.js";
import { isRepeatedProgress, isVerboseOutput } from "./signals.js";

const EXACT_ACTION_REASONS: ReadonlyArray<readonly [SourceLabel, string]> = [
  ["user_instruction", "preserve_exact:user_instruction"],
  ["rule", "preserve_exact:rule"],
  ["acceptance_criterion", "preserve_exact:acceptance_criterion"],
  ["design_decision", "preserve_exact:design_decision"],
  ["open_question", "preserve_exact:open_question"],
  ["command", "preserve_exact:command"],
  ["test_result", "preserve_exact:test_result"],
  ["error_message", "preserve_exact:error_message"],
  ["file_path", "preserve_exact:file_path"],
  ["api_name", "preserve_exact:api_name"],
  ["project_convention", "preserve_exact:project_convention"],
  ["code_reference", "preserve_exact:code_reference"],
  ["exact_value", "preserve_exact:exact_value"],
  ["external_fact", "preserve_exact:external_fact"],
];

export function chooseContextAction(input: {
  fromLongRegion: boolean;
  isDuplicate: boolean;
  labels: SourceLabel[];
  renderedExcerpt: string;
}): { contextAction: ContextAction; actionReason: string } {
  if (input.renderedExcerpt.trim().length === 0) {
    return {
      contextAction: "discard",
      actionReason: "discard:empty",
    };
  }

  if (isRepeatedProgress(input.renderedExcerpt)) {
    return {
      contextAction: "discard",
      actionReason: "discard:repeated_progress",
    };
  }

  if (input.isDuplicate) {
    return {
      contextAction: "discard",
      actionReason: "discard:duplicate_in_turn",
    };
  }

  const exactReason = exactActionReason(input.labels);

  if (exactReason && !isIncidentalExactValue(input.labels, exactReason)) {
    return {
      contextAction: "preserve_exact",
      actionReason: exactReason,
    };
  }

  if (input.labels.includes("tool_output")) {
    return {
      contextAction: "compact",
      actionReason:
        input.fromLongRegion || isVerboseOutput(input.renderedExcerpt)
          ? "compact:long_tool_output"
          : "compact:tool_output",
    };
  }

  if (input.labels.includes("file_output")) {
    return {
      contextAction: "compact",
      actionReason: "compact:long_file_output",
    };
  }

  if (input.labels.includes("reasoning")) {
    return {
      contextAction: "compact",
      actionReason: "compact:reasoning",
    };
  }

  if (input.labels.includes("exploration")) {
    return {
      contextAction: "compact",
      actionReason: "compact:exploration",
    };
  }

  if (input.labels.includes("task_state")) {
    return {
      contextAction: "compact",
      actionReason: "compact:task_state",
    };
  }

  return {
    contextAction: "discard",
    actionReason: "discard:low_signal",
  };
}

function exactActionReason(labels: SourceLabel[]): string | undefined {
  for (const [label, reason] of EXACT_ACTION_REASONS) {
    if (labels.includes(label)) {
      return reason;
    }
  }

  return undefined;
}

function isIncidentalExactValue(
  labels: SourceLabel[],
  exactReason: string,
): boolean {
  return (
    exactReason === "preserve_exact:exact_value" &&
    (labels.includes("reasoning") ||
      labels.includes("exploration") ||
      labels.includes("task_state"))
  );
}
