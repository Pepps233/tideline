import type BetterSqlite3 from "better-sqlite3";

import { embedTexts } from "./embeddings.js";
import {
  roundScore,
  scoreLabels,
  scoreText,
  searchIdentity,
} from "./scoring.js";
import { listSearchIndexEntries } from "./search-index.js";
import type {
  AssemblyRankingCandidate,
  AssemblyRankingScore,
  EmbeddingProvider,
} from "./types.js";

export async function rankAssemblyCandidates(input: {
  candidates: AssemblyRankingCandidate[];
  db: BetterSqlite3.Database;
  embeddingProvider: EmbeddingProvider;
  queryText: string;
  threadId: string;
}): Promise<Map<string, AssemblyRankingScore>> {
  const normalizedQuery = input.queryText.replace(/\s+/g, " ").trim();
  const scores = new Map<string, AssemblyRankingScore>();

  if (input.candidates.length === 0) {
    return scores;
  }

  if (normalizedQuery.length === 0) {
    for (const candidate of input.candidates) {
      scores.set(candidate.key, {
        score: 0,
        reasons: ["deterministic order"],
      });
    }

    return scores;
  }

  const entriesByIdentity = new Map(
    listSearchIndexEntries(input.db, input.threadId).map((entry) => [
      searchIdentity(entry),
      entry,
    ]),
  );
  const [queryEmbedding] = await embedTexts(input.embeddingProvider, [
    normalizedQuery,
  ]);
  const fallbackEmbeddings = await embedTexts(
    input.embeddingProvider,
    input.candidates
      .filter((candidate) => !entriesByIdentity.has(searchIdentity(candidate)))
      .map((candidate) => candidate.text),
  );
  const fallbackByKey = new Map<string, number[]>();
  let fallbackIndex = 0;

  for (const candidate of input.candidates) {
    if (!entriesByIdentity.has(searchIdentity(candidate))) {
      fallbackByKey.set(candidate.key, fallbackEmbeddings[fallbackIndex] ?? []);
      fallbackIndex += 1;
    }
  }

  const maxTurnIndex = Math.max(
    1,
    ...input.candidates.map((candidate) => candidate.turnIndex),
  );

  for (const candidate of input.candidates) {
    const entry = entriesByIdentity.get(searchIdentity(candidate));
    const vector = entry?.embedding ?? fallbackByKey.get(candidate.key) ?? [];
    const scored = scoreText({
      embedding: vector,
      lexicalText: candidate.text,
      query: normalizedQuery,
      queryEmbedding: queryEmbedding ?? [],
    });
    const labelBoost = scoreLabels(candidate.labels);
    const recencyBoost = Math.max(0, candidate.turnIndex / maxTurnIndex) * 0.15;
    const reasons = [...scored.reasons];
    let score = scored.score + labelBoost + recencyBoost;

    if (labelBoost > 0) {
      reasons.push("label signal");
    }

    if (recencyBoost > 0) {
      reasons.push("recency signal");
    }

    if (score === 0) {
      reasons.push("deterministic order");
    }

    scores.set(candidate.key, {
      score: roundScore(score),
      reasons,
    });
  }

  return scores;
}
