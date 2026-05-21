/**
 * Embedder interface for tutorial chunks.
 *
 * The ingestion pipeline embeds each chunk to a 384-dim vector for
 * dense retrieval (DESIGN.md L265: BGE-small-en-v1.5). To keep the
 * native-dep footprint of this PR low, the **real** embedder lives in a
 * separate (future) module that wires in `@huggingface/transformers` and
 * lazy-loads the model on first call. This file defines the abstract
 * `Embedder` interface plus a deterministic `createStubEmbedder` that
 * returns hashed unit vectors — enough to exercise the schema / write
 * path in tests and in offline builds.
 *
 * Why a stub by default
 * ---------------------
 *
 *   - `@huggingface/transformers` pulls in `onnxruntime-node` (~80MB
 *     native). It's listed in DESIGN.md § Native dependencies but is
 *     out of scope for #6 — model download + load lives behind
 *     `GODOT_MCP_MODEL_PATH` and is wired in by the runtime fetcher.
 *   - Build scripts can opt into real embedding by passing a real
 *     embedder via the `Embedder` interface; the stub is the default.
 *   - Tests run without `onnxruntime-node` installed.
 *
 * SHA pinning, model identification (DESIGN.md L557) lives in the real
 * embedder; the stub records its identity as `"stub"` in `modelId`.
 */

import * as crypto from "node:crypto";

/**
 * Output dimensionality of the chosen production model
 * (BGE-small-en-v1.5; DESIGN.md L265). The stub matches so callers can
 * treat the schema's `vec0(embedding float[384])` declaration as
 * non-conditional on which embedder is in use.
 */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Embedder contract. One method (`embed`) takes a batch of strings and
 * returns a same-length batch of vectors. Implementations are
 * responsible for tokenization, batching, and any I/O.
 */
export interface Embedder {
  /**
   * Model identifier — included in `meta.embedding_model_id` so a
   * downstream DB consumer can tell whether they're working with a
   * BGE-embedded DB or a stub-embedded one. For the production
   * embedder this is the HuggingFace revision SHA.
   */
  readonly modelId: string;
  /**
   * Encode each input string to a `EMBEDDING_DIMENSIONS`-long vector.
   * The implementation may batch internally; the caller passes
   * whatever's convenient (the ingest pipeline pre-batches to ~32
   * chunks per call).
   */
  embed(inputs: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Build a deterministic, hash-based stub embedder. The stub:
 *
 *   - Produces the same vector for the same input (suitable for tests
 *     that assert idempotency).
 *   - Produces different vectors for different inputs.
 *   - Returns unit-norm vectors (suitable for cosine similarity).
 *
 * It is NOT a useful embedding for retrieval — distances reflect
 * SHA-256 collisions, not semantic similarity. Production code uses the
 * real BGE embedder.
 */
export function createStubEmbedder(): Embedder {
  return {
    modelId: "stub-sha256-v1",
    async embed(inputs: readonly string[]): Promise<Float32Array[]> {
      return inputs.map(stubVector);
    },
  };
}

/**
 * Hash the input to a deterministic vector. The SHA-256 digest gives us
 * 32 bytes (~8 floats); we extend to `EMBEDDING_DIMENSIONS` by hashing
 * blocks of the input with a counter prefix, then normalize.
 *
 * (This is a stand-in. The shape matches BGE's output so downstream
 * code paths exercise the same buffer sizes.)
 */
function stubVector(text: string): Float32Array {
  const dims = EMBEDDING_DIMENSIONS;
  const bytesNeeded = dims * 4; // float32 → 4 bytes each
  // Sequence of digest blocks until we have enough bytes.
  const out = Buffer.alloc(bytesNeeded);
  let offset = 0;
  let counter = 0;
  while (offset < bytesNeeded) {
    const block = crypto
      .createHash("sha256")
      .update(`${counter}\x00${text}`, "utf8")
      .digest();
    const slice = Math.min(block.length, bytesNeeded - offset);
    block.copy(out, offset, 0, slice);
    offset += slice;
    counter += 1;
  }
  // Interpret as float32 and normalize. Buffer alignment on offset 0 is
  // guaranteed by `Buffer.alloc`.
  const vec = new Float32Array(out.buffer, out.byteOffset, dims);
  // Map the raw uint32 reinterpretation into [-1, 1] so vectors look
  // like real embeddings rather than NaN-laden bit patterns.
  const normalized = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    // Read as int32 then squash to [-1, 1] via division by INT32_MAX.
    const u = out.readInt32LE(i * 4);
    normalized[i] = u / 0x7fffffff;
  }
  // Unit-normalize.
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += normalized[i]! * normalized[i]!;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let i = 0; i < dims; i++) normalized[i] = normalized[i]! * inv;
  // Silence the unused-buffer warning: we read from `out`'s bytes via
  // readInt32LE rather than via the typed-array view.
  void vec;
  return normalized;
}
