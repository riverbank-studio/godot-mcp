/**
 * Part B answer-correctness judge for the chunking quality benchmark (#32).
 *
 * For each query, the harness:
 * 1. Retrieves top-K chunks via the pipeline.
 * 2. Calls a model (held constant per run, version recorded) with the query
 *    and retrieved chunks as context.
 * 3. Calls a judge model to score the model's answer against ground truth.
 *
 * STATUS: STUB — score() returns 0 with a stub rationale until the Anthropic
 * SDK dep is added to this benchmark package. The scaffolding here defines
 * the interface and rubric so the runner can call it uniformly.
 *
 * To activate live scoring:
 * 1. Add `@anthropic-ai/sdk` to benchmarks/chunking-quality/package.json.
 * 2. Replace the stub implementations with real API calls.
 * 3. Set ANTHROPIC_API_KEY in your environment.
 *
 * The judge prompt implements the 3-point rubric from issue #32:
 *   0 — fails to compile/parse, or uses APIs absent from the Godot version.
 *   1 — compiles/makes sense but uses wrong/deprecated APIs or misses cases.
 *   2 — matches ground truth in correctness and is version-appropriate.
 */

import type { PartBQueryResult, QueryRecord, RetrievedChunk } from "./types.js";

/** Options for the Part B judge. */
export interface JudgeOptions {
  /**
   * Model to use for answer generation.
   * Recorded in run metadata; must be held constant across benchmark runs for
   * comparability (issue #32 cost/cadence note).
   */
  answerModel: string;
  /**
   * Model to use for scoring the generated answer against ground truth.
   * Should be the same family as answerModel or stronger.
   */
  judgeModel: string;
  /**
   * Number of chunks to include in the context window for Part B.
   * Default: 5 (matches Recall@5 from Part A).
   */
  contextK?: number;
}

/**
 * Generates a model answer for a query given context chunks.
 *
 * STATUS: STUB — returns a placeholder string.
 */
async function generateAnswer(
  query: string,
  contextChunks: RetrievedChunk[],
  model: string,
): Promise<string> {
  // STUB: replace with Anthropic SDK call.
  // Example (pseudocode):
  //   const client = new Anthropic();
  //   const context = contextChunks.map(c => `## ${c.heading_path}\n${c.content}`).join("\n\n");
  //   const response = await client.messages.create({
  //     model,
  //     max_tokens: 512,
  //     messages: [{ role: "user", content: ANSWER_PROMPT(query, context) }],
  //   });
  //   return response.content[0].text;
  void query;
  void contextChunks;
  void model;
  return "[STUB: Part B answer generation not yet implemented — requires @anthropic-ai/sdk]";
}

/**
 * Judge prompt text for the 3-point rubric.
 *
 * @internal Exported for unit-testing the prompt shape.
 */
export function buildJudgePrompt(
  query: string,
  modelAnswer: string,
  groundTruth: string,
): string {
  return `You are evaluating the quality of an answer to a Godot game engine question.

## Query
${query}

## Ground-truth answer
${groundTruth}

## Answer to evaluate
${modelAnswer}

## Scoring rubric (Godot-MCP benchmark #32)
Score the answer on a 0–2 scale:
- **0**: The answer is wrong, irrelevant, or references APIs that do not exist in Godot 4.x.
- **1**: The answer is partially correct — it compiles/makes sense conceptually but uses
  wrong or deprecated APIs, misses important edge cases, or is misleading.
- **2**: The answer is correct, complete, and uses version-appropriate Godot 4.x APIs.

Reply with exactly this JSON format and nothing else:
{"score": <0|1|2>, "rationale": "<one sentence>"}`;
}

/**
 * Scores a model answer against the ground truth using a judge model.
 *
 * STATUS: STUB — returns score 0 with a stub rationale.
 */
async function judgeAnswer(
  query: string,
  modelAnswer: string,
  groundTruth: string,
  judgeModel: string,
): Promise<{ score: 0 | 1 | 2; rationale: string }> {
  // STUB: replace with Anthropic SDK call.
  // Example (pseudocode):
  //   const client = new Anthropic();
  //   const response = await client.messages.create({
  //     model: judgeModel,
  //     max_tokens: 128,
  //     messages: [{ role: "user", content: buildJudgePrompt(query, modelAnswer, groundTruth) }],
  //   });
  //   const parsed = JSON.parse(response.content[0].text);
  //   return { score: parsed.score as 0|1|2, rationale: parsed.rationale };
  void query;
  void modelAnswer;
  void groundTruth;
  void judgeModel;
  return {
    score: 0,
    rationale:
      "[STUB: Part B judge not yet implemented — requires @anthropic-ai/sdk]",
  };
}

/**
 * Runs Part B evaluation for a single query.
 */
export async function evaluateQuery(
  record: QueryRecord,
  contextChunks: RetrievedChunk[],
  options: JudgeOptions,
): Promise<PartBQueryResult> {
  const k = options.contextK ?? 5;
  const chunks = contextChunks.slice(0, k);

  const modelResponse = await generateAnswer(
    record.query,
    chunks,
    options.answerModel,
  );
  const { score, rationale } = await judgeAnswer(
    record.query,
    modelResponse,
    record.model_answer,
    options.judgeModel,
  );

  return {
    query_id: record.id,
    query: record.query,
    context_chunks: chunks,
    model_response: modelResponse,
    ground_truth: record.model_answer,
    score,
    judge_rationale: rationale,
  };
}
