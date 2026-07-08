import { createHash } from "node:crypto";

import type { EmbeddingProvider } from "./types.js";
import { tokenize } from "./text.js";

const DEFAULT_EMBEDDING_DIMENSIONS = 64;

export function createDefaultEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "local-hash",
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map((text) =>
        hashEmbedding(text, DEFAULT_EMBEDDING_DIMENSIONS),
      );
    },
  };
}

export async function embedTexts(
  embeddingProvider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (
    !Number.isInteger(embeddingProvider.dimensions) ||
    embeddingProvider.dimensions <= 0
  ) {
    throw new Error("embeddingProvider.dimensions must be a positive integer");
  }

  const embeddings = await embeddingProvider.embed(texts);

  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error("embeddingProvider.embed must return one vector per text");
  }

  return embeddings.map((embedding, index) => {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== embeddingProvider.dimensions ||
      !embedding.every((value) => Number.isFinite(value))
    ) {
      throw new Error(
        `embeddingProvider.embed returned an invalid vector at index ${index}`,
      );
    }

    return embedding;
  });
}

function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);

  for (const token of tokenize(text)) {
    const digest = createHash("sha256").update(token, "utf8").digest();
    const dimension = (digest[0] ?? 0) % dimensions;
    const sign = (digest[1] ?? 0) % 2 === 0 ? 1 : -1;

    vector[dimension] = (vector[dimension] ?? 0) + sign;
  }

  return vector;
}
