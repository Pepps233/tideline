import type { SourceLabel, TranscriptRole } from "../types.js";
import { isRepeatedProgress, isVerboseOutput } from "./signals.js";

const SOURCE_LABEL_ORDER: SourceLabel[] = [
  "user_instruction",
  "rule",
  "exact_value",
  "file_path",
  "command",
  "api_name",
  "acceptance_criterion",
  "design_decision",
  "task_state",
  "open_question",
  "tool_output",
  "file_output",
  "test_result",
  "error_message",
  "code_reference",
  "project_convention",
  "reasoning",
  "exploration",
  "external_fact",
];

const SOURCE_LABELS = new Set<string>(SOURCE_LABEL_ORDER);

const USER_INSTRUCTION_PATTERN =
  /^(?:please\b|instructions?:|request:|task:|use\b|add\b|update\b|fix\b|implement\b|create\b|make\b|ensure\b|keep\b|do\b|don't\b|do not\b)/i;
const LOW_SIGNAL_USER_TEXT_PATTERN =
  /^(?:thanks?|thank you|thanks in advance|appreciate it)\b/i;
const RULE_PATTERN =
  /(?:^|\n)\s*(?:rules?|constraints?|guidelines?):|(?:^|\n)\s*-?\s*(?:never|always|must|do not|don't|keep)\b/i;
const ACCEPTANCE_CRITERIA_PATTERN = /(?:^|\n)\s*acceptance criteria?:/i;
const DESIGN_DECISION_PATTERN = /(?:^|\n)\s*(?:decision|decided):/i;
const OPEN_QUESTION_PATTERN = /^(?:questions?:\s*)?.+\?$/i;
const COMMAND_PATTERN =
  /(?:^|\n)\s*command:|```(?:bash|sh|shell|zsh)|(?:^|\n)\s*(?:pnpm|npm|yarn|git|node|npx|turbo|tsc|cargo|go|python|pytest)\b/i;
const TOOL_OUTPUT_PATTERN =
  /(?:^|\n)\s*(?:output|log):|```text|(?:^|\n)\s*TRACE\b|(?:^|\n)\s*not ok\b|(?:^|\n)\s*Error:/i;
const TEST_RESULT_PATTERN =
  /\bnot ok\b|\b(?:test|tests?)\s+(?:failed|failing|passed|passing)\b|AssertionError|ERR_ASSERTION|expected .+ actual/i;
const ERROR_MESSAGE_PATTERN =
  /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|ERR_[A-Z_]+):/;
const FILE_PATH_PATTERN =
  /\b(?:packages|apps|docs|src|test|tests|scripts|infra|\.github)\/[^\s`),]+/;
const API_NAME_PATTERN =
  /\b(?:appendTurn|getSourceItem|listTurnSourceItems|listThreadSourceItems|readTurnRaw|createTranscriptStore)\b/;
const CODE_REFERENCE_PATTERN =
  /\b(?:sourceItemIds|rawPointerId|turnRole|TranscriptStore|StoredSourceItem|ContextAction|SourceLabel)\b|[A-Za-z0-9_$.-]+:\d+\b/;
const PROJECT_CONVENTION_PATTERN =
  /\b(?:project convention|repo convention|coding convention|style convention)\b/i;
const TASK_STATE_PATTERN =
  /\b(?:todo|next step|blocked|in progress|working|done|remaining)\b/i;
const REASONING_PATTERN = /\b(?:because|therefore|reasoning|i think)\b/i;
const EXPLORATION_PATTERN =
  /\b(?:inspect(?:ed|ing)?|checked|search(?:ed|ing)?|explor(?:e|ed|ing))\b/i;
const EXTERNAL_FACT_PATTERN = /\bhttps?:\/\/|\baccording to\b|\bas of \d{4}\b/i;
const EXACT_VALUE_PATTERN =
  /`[^`]+`|["'][^"']+["']|\b(?:true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|[A-Za-z]+[A-Za-z0-9]*\s*\|\s*[A-Za-z]|\b[A-Z_]{2,}\b|@\w+\/[\w-]+|CHANGELOG\.md|sourceItemIds|rawPointerId|turnRole/;

export function classifySourceLabels(
  renderedExcerpt: string,
  turnRole: TranscriptRole,
): SourceLabel[] {
  if (isRepeatedProgress(renderedExcerpt)) {
    return [];
  }

  const labels = new Set<SourceLabel>();
  const trimmedExcerpt = renderedExcerpt.trim();

  if (isUserInstruction(trimmedExcerpt, turnRole)) {
    labels.add("user_instruction");
  }

  if (RULE_PATTERN.test(renderedExcerpt)) {
    labels.add("rule");
  }

  if (ACCEPTANCE_CRITERIA_PATTERN.test(renderedExcerpt)) {
    labels.add("acceptance_criterion");
  }

  if (DESIGN_DECISION_PATTERN.test(renderedExcerpt)) {
    labels.add("design_decision");
  }

  if (OPEN_QUESTION_PATTERN.test(trimmedExcerpt)) {
    labels.add("open_question");
  }

  if (COMMAND_PATTERN.test(renderedExcerpt)) {
    labels.add("command");
  }

  if (TOOL_OUTPUT_PATTERN.test(renderedExcerpt)) {
    labels.add("tool_output");
  }

  if (TEST_RESULT_PATTERN.test(renderedExcerpt)) {
    labels.add("test_result");
  }

  if (ERROR_MESSAGE_PATTERN.test(renderedExcerpt)) {
    labels.add("error_message");
  }

  if (FILE_PATH_PATTERN.test(renderedExcerpt)) {
    labels.add("file_path");
  }

  if (API_NAME_PATTERN.test(renderedExcerpt)) {
    labels.add("api_name");
  }

  if (CODE_REFERENCE_PATTERN.test(renderedExcerpt)) {
    labels.add("code_reference");
  }

  if (PROJECT_CONVENTION_PATTERN.test(renderedExcerpt)) {
    labels.add("project_convention");
  }

  if (TASK_STATE_PATTERN.test(renderedExcerpt)) {
    labels.add("task_state");
  }

  if (REASONING_PATTERN.test(renderedExcerpt)) {
    labels.add("reasoning");
  }

  if (EXPLORATION_PATTERN.test(renderedExcerpt)) {
    labels.add("exploration");
  }

  if (EXTERNAL_FACT_PATTERN.test(renderedExcerpt)) {
    labels.add("external_fact");
  }

  if (
    EXACT_VALUE_PATTERN.test(renderedExcerpt) &&
    !(labels.has("tool_output") && isVerboseOutput(renderedExcerpt))
  ) {
    labels.add("exact_value");
  }

  return sortSourceLabels([...labels]);
}

export function normalizeSourceLabel(label: string): SourceLabel {
  if (SOURCE_LABELS.has(label)) {
    return label as SourceLabel;
  }

  throw new Error(`Unsupported source label: ${label}`);
}

function isUserInstruction(
  trimmedExcerpt: string,
  turnRole: TranscriptRole,
): boolean {
  if (turnRole !== "user" || trimmedExcerpt.length === 0) {
    return false;
  }

  if (LOW_SIGNAL_USER_TEXT_PATTERN.test(trimmedExcerpt)) {
    return false;
  }

  return USER_INSTRUCTION_PATTERN.test(trimmedExcerpt);
}

function sortSourceLabels(labels: SourceLabel[]): SourceLabel[] {
  return labels.sort(
    (left, right) =>
      SOURCE_LABEL_ORDER.indexOf(left) - SOURCE_LABEL_ORDER.indexOf(right),
  );
}
