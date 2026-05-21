/**
 * Tests for the embedder interface + the stub default implementation.
 *
 * The real BGE-small-en-v1.5 model integration is lazy-loaded on demand
 * by the build script; tests pin the stub so the chunking + schema
 * pipeline can be exercised without pulling in `@huggingface/transformers`.
 */

import { describe, it, expect } from "vitest";

import { createStubEmbedder, EMBEDDING_DIMENSIONS } from "./embed.js";

describe("createStubEmbedder", () => {
  it("returns vectors of the correct dimension", async () => {
    const embedder = createStubEmbedder();
    const result = await embedder.embed(["alpha", "bravo"]);
    expect(result.length).toBe(2);
    for (const v of result) {
      expect(v.length).toBe(EMBEDDING_DIMENSIONS);
    }
  });

  it("produces deterministic output for the same input", async () => {
    const embedder = createStubEmbedder();
    const a = await embedder.embed(["hello world"]);
    const b = await embedder.embed(["hello world"]);
    expect(a[0]).toEqual(b[0]);
  });

  it("produces different output for different input", async () => {
    const embedder = createStubEmbedder();
    const a = await embedder.embed(["hello"]);
    const b = await embedder.embed(["world"]);
    expect(a[0]).not.toEqual(b[0]);
  });

  it("returns unit-norm vectors (suitable for cosine similarity)", async () => {
    const embedder = createStubEmbedder();
    const [v] = await embedder.embed(["sample text"]);
    const norm = Math.sqrt(v!.reduce((acc, x) => acc + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });

  it("reports a stable model id", () => {
    const embedder = createStubEmbedder();
    expect(embedder.modelId).toMatch(/stub/);
  });

  it("handles batches of varying size", async () => {
    const embedder = createStubEmbedder();
    expect((await embedder.embed([])).length).toBe(0);
    expect((await embedder.embed(["x"])).length).toBe(1);
    expect(
      (await embedder.embed(Array.from({ length: 16 }, (_, i) => `t${i}`)))
        .length,
    ).toBe(16);
  });
});
