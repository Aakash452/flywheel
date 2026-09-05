/**
 * Pure vector math shared by anything that does an embedding-similarity
 * check: the sourcing pipeline's semantic dedup today, the Creative
 * Engine's >0.9 diversity gate later.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`,
    );
  }
  if (a.length === 0) {
    throw new Error("cosineSimilarity: vectors must be non-empty");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) {
    // A zero vector has no direction to compare. Treat as maximally
    // dissimilar rather than divide by zero — callers using this for
    // dedup should never treat a degenerate embedding as a duplicate.
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
