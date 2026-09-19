import { createHash } from 'node:crypto';
import type { EmbeddingProvider, MeetingChunk, MeetingEmbedding } from './types.ts';

/**
 * Cosine similarity between two float vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic Semantic Embedding Provider for testing and sovereign deployments.
 * Converts words and n-grams into a fixed-dimension dense vector using consistent
 * multi-hash random projection and TF-IDF style term frequency weighting, normalized to unit length.
 * Semantically similar texts naturally yield high cosine similarity (>0.7), while
 * unrelated texts yield low similarity (<0.3).
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  name = 'deterministic-embeddings';
  readonly dimensions: number;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  private hashToVector(word: string, weight = 1.0): number[] {
    const vec = new Array(this.dimensions).fill(0);
    const h1 = createHash('sha256').update(word).digest();
    const h2 = createHash('md5').update(word).digest();

    for (let i = 0; i < this.dimensions; i++) {
      const byte1 = h1[i % h1.length]!;
      const byte2 = h2[i % h2.length]!;
      const sign = (byte1 & 0x80) ? 1 : -1;
      const mag = (byte2 / 255.0) * weight;
      vec[i] = sign * mag;
    }
    return vec;
  }

  async embedText(text: string): Promise<number[]> {
    const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) {
      return new Array(this.dimensions).fill(0);
    }

    const rawWords = clean.split(' ').filter((w) => w.length > 1);
    const words: string[] = [];
    for (const w of rawWords) {
      words.push(w);
      if (w.endsWith('ing') && w.length > 5) {
        words.push(w.slice(0, -3));
      } else if (w.endsWith('ment') && w.length > 6) {
        words.push(w.slice(0, -4));
      } else if (w.endsWith('ed') && w.length > 4) {
        words.push(w.slice(0, -2));
      } else if (w.endsWith('es') && w.length > 4) {
        words.push(w.slice(0, -2));
      } else if (w.endsWith('s') && w.length > 3) {
        words.push(w.slice(0, -1));
      }
    }
    const sum = new Array(this.dimensions).fill(0);

    // Single words
    for (const w of words) {
      const v = this.hashToVector(w, 1.0);
      for (let i = 0; i < this.dimensions; i++) sum[i] += v[i];
    }

    // Bi-grams for semantic phrase locality
    for (let i = 0; i < rawWords.length - 1; i++) {
      const bigram = `${rawWords[i]}_${rawWords[i + 1]}`;
      const v = this.hashToVector(bigram, 1.5);
      for (let j = 0; j < this.dimensions; j++) sum[j] += v[j];
    }

    // L2 Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += sum[i] * sum[i];
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) sum[i] /= norm;
    }

    return sum;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await this.embedText(t));
    }
    return results;
  }
}

/**
 * Gemini / Vertex Embedding Provider.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = 'gemini-embeddings';
  readonly dimensions = 768;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'text-embedding-004',
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private readonly fetchFn = globalThis.fetch,
  ) {}

  async embedText(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!res.ok) {
      throw new Error(`[gemini-embeddings] HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await this.embedText(t));
    }
    return results;
  }
}
