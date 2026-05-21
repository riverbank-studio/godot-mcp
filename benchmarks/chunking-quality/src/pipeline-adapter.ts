/**
 * Pipeline adapter: thin interface between the benchmark harness and the
 * actual docs search/retrieval pipeline (#6 + #7).
 *
 * This module is intentionally written as a *stub* so the harness compiles
 * and the scaffolding is complete. Live execution is gated on deps #6 (docs
 * ingestion) and #7 (docs tools) merging into main.
 *
 * To wire the harness to the real pipeline:
 * 1. Import the compiled src/docs/search.ts module (or call the MCP tool
 *    directly via stdio/HTTP depending on how the test runner is set up).
 * 2. Replace `searchTutorials` with a real call and map the result shape to
 *    RetrievedChunk[].
 * 3. Replace `getAllChunks` with a query against the docs SQLite DB.
 *
 * The stub returns empty arrays so --dry-run and schema-validation tests work
 * without the pipeline being available.
 */

import type { RetrievedChunk } from "./types.js";

/**
 * Search configuration passed to the retrieval pipeline.
 * Mirrors the parameters of godot_search_tutorials (#7).
 */
export interface SearchOptions {
  /** Maximum number of results to return. */
  limit: number;
  /**
   * Path to the compiled docs database file.
   * Required for live runs; ignored in dry-run / stub mode.
   */
  dbPath?: string;
}

/**
 * Runs a single query through the tutorial search pipeline and returns
 * ranked chunks.
 *
 * STATUS: STUB — returns empty array until deps #6 + #7 merge.
 *
 * In live mode this calls the hybrid FTS5 + dense-retrieval pipeline
 * described in DESIGN.md § Search → Tutorials.
 */
export async function searchTutorials(
  query: string,
  options: SearchOptions,
): Promise<RetrievedChunk[]> {
  // STUB: replace with real pipeline call when deps land.
  // Example (pseudocode):
  //   const { search } = await import("../../src/docs/search.js");
  //   const results = await search(query, { limit: options.limit, dbPath: options.dbPath });
  //   return results.map(mapToRetrievedChunk);
  void query;
  void options;
  return [];
}

/**
 * Retrieves all indexed chunks from the docs DB for chunk-length distribution
 * analysis (Part of the acceptance criteria: no chunks over 3000 tokens,
 * ≤ 5% under 100 tokens).
 *
 * STATUS: STUB — returns empty array until dep #6 merges.
 *
 * In live mode this is a SELECT * FROM tutorial_chunks (or equivalent).
 */
export async function getAllChunks(options: {
  dbPath?: string;
}): Promise<RetrievedChunk[]> {
  // STUB: replace with real DB query when dep #6 lands.
  void options;
  return [];
}

/**
 * Retrieves docs-DB metadata for recording in the run config.
 *
 * STATUS: STUB — returns nulls until dep #6 merges.
 */
export async function getDocsMetadata(options: {
  dbPath?: string;
}): Promise<{ docs_version: string | null; embedding_model: string | null }> {
  // STUB: replace with SELECT from meta table when dep #6 lands.
  void options;
  return { docs_version: null, embedding_model: null };
}
