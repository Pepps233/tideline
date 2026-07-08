const TOKEN_PATTERN = /[a-z0-9]+/g;
const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "keep",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

export function areSameTopic(left: string, right: string): boolean {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const sharedTokens = sharedTokensFor(leftTokens, rightTokens);
  const smallerSize = Math.max(1, Math.min(leftTokens.size, rightTokens.size));

  return sharedTokens.length >= 2 || sharedTokens.length / smallerSize >= 0.25;
}

export function sharedTokenCount(left: string, right: string): number {
  return sharedTokensFor(new Set(tokenize(left)), new Set(tokenize(right)))
    .length;
}

export function mentionsSupersede(text: string): boolean {
  return /\b(?:supersedes?|replaces?|replaced|deprecates?|instead of|no longer)\b/i.test(
    text,
  );
}

export function mentionsRefine(text: string): boolean {
  return /\b(?:refines?|clarifies?|narrows?|updates?)\b/i.test(text);
}

export function mentionsResolve(text: string): boolean {
  return /\b(?:resolves?|resolved|answered|confirmed)\b/i.test(text);
}

export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

export function tokenize(text: string): string[] {
  return Array.from(normalizeSearchableText(text).matchAll(TOKEN_PATTERN))
    .map((match) => match[0])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function normalizeSearchableText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function sharedTokensFor(
  leftTokens: Set<string>,
  rightTokens: Set<string>,
): string[] {
  return [...leftTokens].filter((token) => rightTokens.has(token));
}
