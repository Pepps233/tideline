const VERBOSE_OUTPUT_MIN_CHARS = 2000;
const VERBOSE_OUTPUT_MIN_LINES = 40;

const REPEATED_PROGRESS_LINE_PATTERN =
  /^(?:still working|working|processing|running|waiting|loading)\.{0,3}$/i;

export function isRepeatedProgress(renderedExcerpt: string): boolean {
  const lines = renderedExcerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return false;
  }

  const firstLine = lines[0];

  if (!firstLine || !REPEATED_PROGRESS_LINE_PATTERN.test(firstLine)) {
    return false;
  }

  return lines.every((line) => line === firstLine);
}

export function isVerboseOutput(renderedExcerpt: string): boolean {
  return (
    renderedExcerpt.length > VERBOSE_OUTPUT_MIN_CHARS ||
    renderedExcerpt.split(/\r?\n/).length > VERBOSE_OUTPUT_MIN_LINES
  );
}
