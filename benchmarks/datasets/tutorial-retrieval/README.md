# Tutorial Retrieval Benchmark Dataset

Fixture dataset for benchmark #32 (Chunking quality + correctness).
Tracks issue #42.

## Location

```
benchmarks/datasets/tutorial-retrieval/v1/queries.jsonl
```

## Schema

Each line of `queries.jsonl` is a JSON object with this shape:

```jsonc
{
  "id": "q-001", // Unique identifier, zero-padded three-digit integer
  "query": "...", // Verbatim query as an agent would phrase it
  "answer_anchors": [
    // One or more acceptable answer locations
    {
      "path": "tutorials/2d/2d_lights_and_shadows.rst", // RST file path relative to godot-docs repo root
      "heading": "Shadow filtering", // Section heading within that page
    },
  ],
  "model_answer": "...", // Short canonical answer paragraph for Part B answer-correctness scoring
  "categories": ["procedural"], // One or more of: conceptual, procedural, api-discovery, troubleshooting
  "godot_version": "4.5", // Godot version this query/answer is valid for
  "split": "train", // "train" (used during tuning) or "held-out" (reserved for final eval)
}
```

### `answer_anchors`

A retrieval result "covers" an anchor when:

- The chunk's page path matches `path`, AND
- The chunk's heading_path either contains or is contained by `heading`

This makes recall stable across chunking configs (per Wave 2 finding H3 and benchmark #32 Part C A/B testing).

Multiple `answer_anchors` indicate that more than one page section acceptably answers the query.

## Category taxonomy

| Category          | Description                                 | Example                                            |
| ----------------- | ------------------------------------------- | -------------------------------------------------- |
| `conceptual`      | "What is X?" or "How does X differ from Y?" | "What is a SubViewport?"                           |
| `procedural`      | Step-by-step how-to                         | "How do I export a scene to GLTF?"                 |
| `api-discovery`   | Finding the right API for a task            | "What is the recommended way to do X?"             |
| `troubleshooting` | Debugging why something doesn't work        | "Why is my RigidBody3D falling through the floor?" |

## Dataset statistics

| Metric                               | Value                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| Total queries                        | 60                                                         |
| Train split                          | 50                                                         |
| Held-out split                       | 10                                                         |
| Queries with multiple answer_anchors | ≥ 5                                                        |
| Categories covered                   | 4 (conceptual, procedural, api-discovery, troubleshooting) |
| Minimum per category                 | ≥ 8                                                        |

## Held-out split

Queries with `"split": "held-out"` (q-051 through q-060) are reserved for final benchmark evaluation and must not be used during chunking parameter tuning. They are stored in the same file for schema consistency; the validation script enforces the count.

## Validation

Run the validation script to verify dataset shape and counts:

```bash
node scripts/validate-tutorial-queries.mjs
```

The script is also wired into `npm test` via Vitest.

## Grounding notes

All `answer_anchors` paths are relative to the root of the [godot-docs](https://github.com/godotengine/godot-docs) repository (RST source). The heading strings correspond to reStructuredText section headings within those files. During actual benchmark scoring, chunk paths are compared against these anchors using the containment rule described above.

## Versioning

This is `v1` of the dataset. Subsequent versions (e.g., `v2/`) may update queries for newer Godot releases or correct anchor locations after human review. The `v1/` directory is immutable once benchmark #32 produces published results.
