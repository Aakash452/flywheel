/**
 * Minimal client for Voyage AI's embeddings endpoint.
 *
 * Voyage is not in the build spec's literal integrations list — but the
 * spec requires "semantic similarity" dedup in sourcing and ">0.9 cosine
 * similarity" checks in the Creative Engine, and neither is possible
 * without an embedding provider. This is the one assumed throughout the
 * codebase (see the deviation note on `creatives.embedding` in
 * src/db/schema.ts); `outputDimension` defaults to 1024 to match every
 * `vector(1024)` column in the schema.
 */
export interface EmbeddingResult {
  embeddings: number[][];
  tokens: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface VoyageClientConfig {
  apiKey: string;
  model?: string;
  outputDimension?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";
const DEFAULT_MODEL = "voyage-3-large";
const DEFAULT_OUTPUT_DIMENSION = 1024;

interface VoyageEmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export class VoyageClient implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly outputDimension: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: VoyageClientConfig) {
    if (!config.apiKey) throw new Error("VoyageClient requires an apiKey");
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.outputDimension = config.outputDimension ?? DEFAULT_OUTPUT_DIMENSION;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { embeddings: [], tokens: 0 };

    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        output_dimension: this.outputDimension,
        input_type: "document",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Voyage embeddings request failed with ${res.status}: ${body}`,
      );
    }

    const json = (await res.json()) as VoyageEmbeddingsResponse;
    // Voyage documents results as returned in request order, but sorting
    // by the response's own `index` costs nothing and removes the
    // assumption entirely.
    const embeddings = [...json.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    return { embeddings, tokens: json.usage?.total_tokens ?? 0 };
  }
}

/** Returns undefined (not a throw) when VOYAGE_API_KEY is unset, so callers can degrade to URL-only dedup. */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider | undefined {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return undefined;
  return new VoyageClient({ apiKey });
}
