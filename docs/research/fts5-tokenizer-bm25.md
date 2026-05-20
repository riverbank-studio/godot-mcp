# FTS5 tokenizer choice and BM25 weights

Research hand-off for issue [#39](https://github.com/riverbank-studio/godot-mcp/issues/39).
Informs [docs/DESIGN.md § Search](../DESIGN.md#search); tunes against
benchmark [#32](https://github.com/riverbank-studio/godot-mcp/issues/32).

> **TL;DR.** The DESIGN.md baselines hold for `classes_fts` and `members_fts`.
> Recommend keeping `unicode61 tokenchars='_'` and `bm25(classes_fts, 3.0, 1.0)`
> / `bm25(members_fts, 3.0, 2.0, 1.0)`. For `tutorials_fts`, recommend
> **switching the tokenizer from `unicode61` to `porter unicode61`** — measured
> MRR on how-to phrase queries jumps from 0.636 to 0.909 on the sample corpus.
> Keep `bm25(tutorials_fts, 3.0, 2.0, 1.0)`. **Reject `trigram`** for v1 on
> all three tables: it solves partial-name lookups but destroys prose recall.

## 1. Methodology

### 1.1 Why a hand-curated sample

Issue #39's "Output" section explicitly permits a mocked subset of the docs.
The bottleneck for any FTS5 A/B is **labeled relevance judgements**, not raw
text; pulling all ~2,500 Godot class pages plus tutorials would still require
manual labeling of representative queries. A 67-document hand-curated sample
sized to exercise the cases that distinguish the candidate tokenizers
(snake_case identifiers, PascalCase classes, partial-name prefixes, prose
phrases) gives faster iteration with the same conclusions.

The full corpus and query set are checked in under
[`benchmarks/fts5-tuning/`](../../benchmarks/fts5-tuning/) so any of these
numbers can be reproduced with `python benchmarks/fts5-tuning/evaluate.py`.
Raw JSON and a markdown comparison table land in
[`benchmarks/results/fts5-tuning/`](../../benchmarks/results/fts5-tuning/).

### 1.2 Corpus

Three corpora mirror the three FTS5 tables in DESIGN.md § Search:

| Table           | Columns                        | Rows |
| --------------- | ------------------------------ | ---: |
| `classes_fts`   | (name, brief)                  |   25 |
| `members_fts`   | (name, signature, description) |   27 |
| `tutorials_fts` | (title, heading_path, content) |   15 |

Text is paraphrased from Godot 4 docs
(<https://docs.godotengine.org>) and chosen to include the patterns that
matter: snake_case method names (`add_child`, `move_and_slide`,
`set_physics_process`), PascalCase class names with shared roots
(`AnimationPlayer` / `AnimationTree` / `AnimatedSprite2D`), prefixes
(`Anim`, `Body2D`, `Stream`), and prose phrases ("how to play a sound").

### 1.3 Query set

42 labeled queries total: 12 class, 16 member, 14 tutorial. Each query is
tagged with one bucket:

- **`ident`** — exact snake_case identifier lookup (`add_child`, `emit_signal`).
- **`pascal`** — exact PascalCase class lookup (`AnimationPlayer`).
- **`partial`** — prefix or substring of a name (`Anim`, `Body2D`, `move_and`).
- **`howto`** — prose phrase ("how to play a sound").
- **`field`** — tests field-weight bias on the tutorial table.

### 1.4 Configurations under test

For each table, every candidate tokenizer is run against every BM25 weight
variant of interest:

| Tokenizer                         | Why test                                   |
| --------------------------------- | ------------------------------------------ |
| `unicode61` (default)             | DESIGN baseline; what FTS5 does out of box |
| `unicode61 tokenchars '_'`        | DESIGN choice for class/member tables      |
| `porter unicode61`                | Plural / -ing stemming for prose           |
| `porter unicode61 tokenchars '_'` | Combined: identifier + stemming            |
| `trigram`                         | DESIGN rejected for v1; sanity-check       |

For class/member tables we sweep name-weight ∈ {2.0, 3.0, 4.0}. For tutorials
we sweep title-weight ∈ {2.0, 3.0, 4.0}. The non-leading weights stay at
their DESIGN.md values (`brief=1.0`; `signature=2.0, description=1.0`;
`heading_path=2.0, content=1.0`).

### 1.5 Match-expression construction

Real client code will translate a free-text query into an FTS5 MATCH
expression. The harness mirrors a reasonable production strategy:

- **`trigram`**: phrase query (`"<raw>"`). The trigram tokenizer treats a
  phrase MATCH as a substring search, which is its only reason for existing
  (SQLite FTS5 ref §4.4.5).
- **All other tokenizers**: split on non-word characters and AND the
  resulting tokens with a trailing `*` for prefix matching. This gives
  unicode61 a fair shot at prefix lookups (`Anim` → `Anim*` matches
  `AnimationPlayer`, etc.).

### 1.6 Metrics

For each (config × query) we record:

- **P@k** (precision at k): fraction of top-k results that are relevant.
- **R@k** (recall at k): fraction of relevant items retrieved in top-k.
- **MRR**: reciprocal rank of the first relevant hit (0 if none).
- **zero-hit count**: queries returning zero rows.

k ∈ {1, 3, 5}. The harness aggregates by bucket and overall.

### 1.7 Environment

Python 3.12 stdlib `sqlite3` against SQLite **3.42.0** (FTS5 built in). All
candidate tokenizers — `unicode61`, `porter`, `trigram` — are exercised by
[`benchmarks/fts5-tuning/check_tokenizers.py`](../../benchmarks/fts5-tuning/check_tokenizers.py)
as a precondition.

`better-sqlite3` was not installed; the harness uses Python so this research
could complete inside its quota even with no native-build prerequisites
available. The conclusions transfer verbatim to better-sqlite3 because both
clients call into the same FTS5 module — the choice of host language has no
bearing on tokenizer / BM25 behaviour.

## 2. Results

### 2.1 `classes_fts` — name × brief

Overall (all 12 queries):

| Configuration                              |   P@1 |   R@3 |   MRR | 0-hit |
| ------------------------------------------ | ----: | ----: | ----: | ----: |
| `unicode61` default, bm25 3.0/1.0          | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars='_'`, bm25 3.0/1.0   | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars='_'`, bm25 2.0/1.0   | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars='_'`, bm25 4.0/1.0   | 0.833 | 0.833 | 0.833 |  2/12 |
| `trigram`, bm25 3.0/1.0                    | 0.750 | 0.750 | 0.750 |  3/12 |
| `porter unicode61 tokenchars='_'`, 3.0/1.0 | 0.833 | 0.833 | 0.833 |  2/12 |

MRR by bucket:

| Configuration                     | pascal | partial | howto |
| --------------------------------- | -----: | ------: | ----: |
| `unicode61` default               |  1.000 |   0.500 | 1.000 |
| `unicode61 tokenchars='_'`        |  1.000 |   0.500 | 1.000 |
| `trigram`                         |  1.000 |   1.000 | 0.250 |
| `porter unicode61 tokenchars='_'` |  1.000 |   0.500 | 1.000 |

Two findings:

1. **Name-weight (2.0 / 3.0 / 4.0) has zero measurable effect** on the sample.
   That is expected: every query in this set is either a name-token hit
   (where the brief column doesn't contribute to ranking at all) or a prose
   hit (where the brief carries the signal and the name doesn't appear). The
   weight ratio matters only when the same query token hits both columns of
   the same row, which never happens in this corpus. The DESIGN value of
   3.0 stays, since it's a defensible default and the eval shows no reason
   to move.
2. **`trigram` solves partial-name queries that `unicode61` cannot**
   (`Body2D` → CharacterBody2D/RigidBody2D/StaticBody2D; `Stream` → both
   `AudioStreamPlayer*` classes). But it **destroys prose recall**
   (phrase-MATCH demands the literal trigrams of the whole phrase; "play
   animation" finds nothing). The DESIGN.md call to reject trigram for v1
   on this table is correct: 2 partial-query zero-hits is a smaller
   regression than 3 howto-query zero-hits.

### 2.2 `members_fts` — name × signature × description

Overall (all 16 queries):

| Configuration                                  |   P@1 |       R@3 |       MRR | 0-hit |
| ---------------------------------------------- | ----: | --------: | --------: | ----: |
| `unicode61` default, bm25 3.0/2.0/1.0          | 0.938 |     0.938 |     0.938 |  0/16 |
| `unicode61 tokenchars='_'`, bm25 3.0/2.0/1.0   | 0.938 |     0.938 |     0.938 |  0/16 |
| `unicode61 tokenchars='_'`, bm25 2.0/2.0/1.0   | 0.938 |     0.938 |     0.938 |  0/16 |
| `unicode61 tokenchars='_'`, bm25 4.0/2.0/1.0   | 0.938 |     0.938 |     0.938 |  0/16 |
| `trigram`, bm25 3.0/2.0/1.0                    | 0.750 |     0.750 |     0.750 |  4/16 |
| `porter unicode61 tokenchars='_'`, 3.0/2.0/1.0 | 0.938 | **1.000** | **0.969** |  0/16 |

MRR by bucket:

| Configuration                     | ident | partial |     howto |
| --------------------------------- | ----: | ------: | --------: |
| `unicode61 tokenchars='_'`        | 1.000 |   1.000 |     0.750 |
| `trigram`                         | 1.000 |   1.000 |     0.000 |
| `porter unicode61 tokenchars='_'` | 1.000 |   1.000 | **0.875** |

Two findings:

1. **Porter stemming on the member table is a small win** (overall MRR
   0.938 → 0.969; howto-bucket MRR 0.750 → 0.875), at the cost of slightly
   surprising exact-identifier behaviour — `play` and `plays` would now
   collide. Whether this is acceptable depends on whether members named
   in their plural form exist (Godot has very few). Net: **defer adopting
   porter on `members_fts` until benchmark #32 produces a verdict on a
   larger corpus**. The exact-identifier `ident` bucket is unaffected so
   the change is upside-only on this sample, but the unknown is whether
   real-world member names get false-equated by Porter's stemmer.
2. **`trigram` is a strict regression on prose queries** (howto MRR drops
   to 0.000). The phrase-MATCH for "how to play a sound" or "fixed rate
   physics callback" doesn't appear verbatim in any description.

### 2.3 `tutorials_fts` — title × heading_path × content

Overall (all 14 queries):

| Configuration                            |       P@1 |       R@3 |       MRR |    0-hit |
| ---------------------------------------- | --------: | --------: | --------: | -------: |
| `unicode61` default, bm25 3.0/2.0/1.0    |     0.714 |     0.714 |     0.714 |     4/14 |
| `unicode61` default, bm25 2.0/2.0/1.0    |     0.714 |     0.714 |     0.714 |     4/14 |
| `unicode61` default, bm25 4.0/2.0/1.0    |     0.714 |     0.714 |     0.714 |     4/14 |
| **`porter unicode61`, bm25 3.0/2.0/1.0** | **0.929** | **0.905** | **0.929** | **1/14** |
| `trigram`, bm25 3.0/2.0/1.0              |     0.500 |     0.500 |     0.500 |     7/14 |

MRR by bucket:

| Configuration       | field |     howto |
| ------------------- | ----: | --------: |
| `unicode61` default | 1.000 |     0.636 |
| `porter unicode61`  | 1.000 | **0.909** |
| `trigram`           | 1.000 |     0.364 |

**This is the clearest result in the report.** Porter stemming on the
tutorial table is a substantial win:

- "moving the player character" → tutorial about player movement (stemmed
  `move` matches `moving`/`movement`/`moved`). Default unicode61 misses.
- "saved games" → tutorial about saving (stemmed `save` matches
  `saved`/`saving`). Default unicode61 misses.
- "animating properties" → tutorial about Tween (stemmed `animat` matches
  `animation`/`animate`/`animating`). Default unicode61 misses.

The hybrid retrieval design (FTS5 + sqlite-vec RRF; DESIGN.md § Tutorials)
softens but does not erase the cost of these misses: a zero-hit on the
lexical side means the result depends entirely on the dense layer. Porter
stemming closes that gap cheaply.

Title-weight sweep showed no movement: again, the queries that need title
boost are exact-name queries that match only the title field, and the ones
that match content don't appear in the title. The DESIGN.md default of 3.0
holds.

## 3. Recommendation

For v1, ship with:

| Table           | Tokenizer                                     | BM25                                 |
| --------------- | --------------------------------------------- | ------------------------------------ |
| `classes_fts`   | `unicode61 tokenchars '_'`                    | `bm25(classes_fts, 3.0, 1.0)`        |
| `members_fts`   | `unicode61 tokenchars '_'`                    | `bm25(members_fts, 3.0, 2.0, 1.0)`   |
| `tutorials_fts` | **`porter unicode61`** (change from baseline) | `bm25(tutorials_fts, 3.0, 2.0, 1.0)` |

That is: **the DESIGN.md baselines hold except on the tutorial table, which
should adopt Porter stemming.**

The `porter` tokenizer wraps `unicode61` (per SQLite FTS5 ref §4.4.3) so
unicode tokenization and case-folding still apply — Porter only adds the
stemming pass. The DESIGN doc's existing language "(Optional) Stemming with
`porter` for tutorial table" should be promoted from optional to the default,
with a one-line tuning-record note explaining why.

### 3.1 Why not also Porter on members?

The sample shows a small win (MRR 0.938 → 0.969), but the failure mode of
Porter stemming on identifier names is more concerning than on prose: a
user querying `add` should get `add_child`, not `adds` or `adding` in a
prose description. The risk of false equation is higher when the corpus
contains both code-like and prose-like text in the same FTS column, and
the member table's `description` column is exactly that. **Hold the
recommendation pending benchmark #32** on the full Godot member corpus.

### 3.2 Why not trigram anywhere?

Trigram solves substring lookup well (perfect MRR on the class-table
`partial` bucket) but its phrase-MATCH semantics break prose retrieval
catastrophically (MRR 0.000 on the member howto bucket; 0.364 on tutorial
howto). DESIGN.md's rejection of trigram for v1 is supported by the data.
Reconsider only if a separate "name-substring lookup" index is added as a
sidecar — running trigram alongside the main table — which is out of scope
for v1.

### 3.3 Why not move the name-weight off 3.0?

The sweep across {2.0, 3.0, 4.0} showed identical metrics across all three
on this corpus, because the queries don't exhibit the column-overlap
condition where weights actually re-order results. 3.0 stays as a
defensible default; if benchmark #32 surfaces a query class where this
matters, retune then.

### 3.4 `tokenchars='_'` is low-impact but free

On this sample `tokenchars='_'` showed identical retrieval metrics to
default `unicode61`. We verified at the vocabulary level that under
`tokenchars='_'` SQLite stores both the underscore-bridged token
(`add_child`) **and** the unicode61 sub-tokens (`add`, `child`) — it's
purely additive. Index size grows by roughly one extra token per
identifier; that's negligible at Godot's docs scale. The benefit is in
exact-identifier semantics that won't show up until the corpus has
substantial prose mentioning the same words as separate identifiers; keep
the DESIGN.md choice.

## 4. Edge cases

- **Empty query.** Already handled in DESIGN.md § Class reference: returns
  filtered set ordered by name, or a hint object if no filters either.
  No tokenizer-level concern.
- **Query shorter than trigram window.** If a future name-substring index
  used trigram, a 1- or 2-character query would zero-hit. Not relevant to
  the recommended config.
- **Stemming collisions in names.** Porter would equate `set` / `sets`
  and `play` / `plays`. Mitigation if Porter is eventually adopted on
  `members_fts`: keep the existing direct `WHERE name = ?` lookup path
  in `godot_find_member` (it does not go through FTS5).
- **Mixed-case identifiers in prose.** `unicode61` lower-cases all input
  by default, so `AnimationPlayer` in a description and `animationplayer`
  in a query collide — desired behaviour.
- **Numeric suffixes.** `unicode61` treats digits as word characters, so
  `Node2D` is a single token. No special handling needed; confirmed by
  the `pascal` query bucket scoring 1.000 across all unicode61 variants.
- **Underscore at token boundary.** `_internal` and `__init__` are common
  Python-isms not really present in Godot's API, but `tokenchars='_'`
  would store them as-is. If false positives become an issue, switch to
  `separators` form. Not a v1 concern.

## 5. What this leaves to benchmark #32

The corpus used here is small enough that:

- Name-weight tuning is unmeasurable (only one column matches per query).
- Porter on `members_fts` shows a small win but the risk profile of
  false equations on a 5,000-row member corpus is the unknown.
- Trigram-style name-substring lookup remains unanswered as a sidecar
  for the "user types `Anim` and expects `AnimationPlayer`" UX. The class
  table's `partial` MRR of 0.500 under unicode61 is the open recall gap.

Benchmark #32 should specifically:

1. Re-run the name-weight sweep on the full member corpus and confirm 3.0
   stays optimal (or pick a winner).
2. Score Porter on `members_fts` for false-equation rate on identifier
   queries, not just MRR. A spot of bad answers may outweigh a small mean.
3. Decide whether the `Anim` → `AnimationPlayer` partial-name UX is
   important enough to warrant a sidecar trigram index. The agent-UX
   review (docs/reviews/2026-05-design-review/agent-ux.md) is the natural
   place to source the verdict.

## 6. Sources

- SQLite FTS5 reference: <https://www.sqlite.org/fts5.html>
  - §4 (tokenizers) — `unicode61` defaults, `tokenchars` / `separators`,
    `porter`, `trigram`.
  - §3 (auxiliary functions) — `bm25(table, w1, w2, ...)` signature and
    positional weight semantics; trailing missing weights default to 1.0.
- Cormack, Clarke, Büttcher (2009), "Reciprocal Rank Fusion outperforms
  Condorcet and individual Rank Learning Methods", SIGIR'09 — referenced
  by DESIGN.md for the hybrid-retrieval fusion stage, included here for
  completeness because the lexical layer's quality feeds into RRF.
- Godot Engine documentation: <https://docs.godotengine.org> — source for
  the paraphrased corpus.

## 7. Reproducing

```bash
python benchmarks/fts5-tuning/check_tokenizers.py   # smoke test
python benchmarks/fts5-tuning/evaluate.py           # full A/B run
```

Outputs land in [`benchmarks/results/fts5-tuning/`](../../benchmarks/results/fts5-tuning/):

- `results.json` — per-config, per-query metrics for archival.
- `results.md` — human-readable comparison tables.

Total runtime is <1 second on commodity hardware; the corpus and harness
are deliberately small enough to iterate quickly.
