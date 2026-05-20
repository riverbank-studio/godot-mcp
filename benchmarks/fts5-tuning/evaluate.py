"""FTS5 tokenizer / BM25-weight evaluation harness.

Runs the labeled queries in queries.py against the corpora in corpus.py
under several (tokenizer, bm25-weight) configurations. Reports precision@k,
recall@k, and MRR per query bucket and overall, plus zero-hit failure counts.

Usage:
    python benchmarks/fts5-tuning/evaluate.py

Writes:
    benchmarks/results/fts5-tuning/results.json   raw per-config metrics
    benchmarks/results/fts5-tuning/results.md     human-readable tables
"""

import json
import sqlite3
import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from corpus import all_classes, all_members, all_tutorials
from queries import CLASS_QUERIES, MEMBER_QUERIES, TUTORIAL_QUERIES

RESULT_DIR = ROOT.parent / "results" / "fts5-tuning"
RESULT_DIR.mkdir(parents=True, exist_ok=True)

K_VALUES = (1, 3, 5)
LIMIT = max(K_VALUES)


# ---------------------------------------------------------------------------
# FTS5 query construction
# ---------------------------------------------------------------------------

_FTS5_PUNCT_RE = re.compile(r"[^\w_]+")


def fts5_match_query(raw, tokenizer):
    """Build a MATCH expression from a free-text query.

    Strategy mirrors how the production search code is likely to call FTS5:
    - For trigram, pass the query unmodified inside a phrase (\"...\") so that
      MATCH treats it as a substring lookup, which is the trigram tokenizer's
      whole reason for existing.
    - For all other tokenizers, split on non-word characters and AND the
      resulting non-empty tokens with a trailing * for prefix matching. This
      gives unicode61 a fair shot at partial-name queries.
    """
    if tokenizer == "trigram":
        # Trigram MATCH treats phrase queries as substring searches.
        escaped = raw.replace('"', '""')
        return f'"{escaped}"'
    parts = [p for p in _FTS5_PUNCT_RE.split(raw) if p]
    if not parts:
        return None
    return " ".join(f"{p}*" for p in parts)


# ---------------------------------------------------------------------------
# Index builders
# ---------------------------------------------------------------------------

def build_classes(con, tokenizer):
    """Create classes_fts under the requested tokenizer and load the corpus."""
    con.execute("DROP TABLE IF EXISTS classes_fts")
    con.execute(
        f"CREATE VIRTUAL TABLE classes_fts USING fts5("
        f"name, brief, tokenize=\"{tokenizer}\")"
    )
    for rowid, name, brief in all_classes():
        con.execute(
            "INSERT INTO classes_fts(rowid, name, brief) VALUES (?, ?, ?)",
            (rowid, name, brief),
        )


def build_members(con, tokenizer):
    """Create members_fts under the requested tokenizer and load the corpus."""
    con.execute("DROP TABLE IF EXISTS members_fts")
    con.execute(
        f"CREATE VIRTUAL TABLE members_fts USING fts5("
        f"name, signature, description, tokenize=\"{tokenizer}\")"
    )
    for rowid, name, sig, desc in all_members():
        con.execute(
            "INSERT INTO members_fts(rowid, name, signature, description) VALUES (?, ?, ?, ?)",
            (rowid, name, sig, desc),
        )


def build_tutorials(con, tokenizer):
    """Create tutorials_fts under the requested tokenizer and load the corpus."""
    con.execute("DROP TABLE IF EXISTS tutorials_fts")
    con.execute(
        f"CREATE VIRTUAL TABLE tutorials_fts USING fts5("
        f"title, heading_path, content, tokenize=\"{tokenizer}\")"
    )
    for rowid, title, hp, content in all_tutorials():
        con.execute(
            "INSERT INTO tutorials_fts(rowid, title, heading_path, content) VALUES (?, ?, ?, ?)",
            (rowid, title, hp, content),
        )


# ---------------------------------------------------------------------------
# Search runners
# ---------------------------------------------------------------------------

def run_search(con, table, match_expr, weights, limit):
    """Run a single bm25-ranked MATCH against `table`, returning rowids in order.

    `weights` is the tuple of per-column floats passed to bm25(). Order matches
    the column order in the CREATE VIRTUAL TABLE statement.
    """
    if match_expr is None:
        return []
    weight_args = ", ".join(str(w) for w in weights)
    sql = (
        f"SELECT rowid FROM {table} "
        f"WHERE {table} MATCH ? "
        f"ORDER BY bm25({table}, {weight_args}) "
        f"LIMIT {limit}"
    )
    try:
        return [row[0] for row in con.execute(sql, (match_expr,))]
    except sqlite3.OperationalError:
        # FTS5 rejects some token-only queries under certain tokenizers (e.g.
        # trigram requires >=3 chars). Count as zero hits.
        return []


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def precision_at_k(returned, relevant, k):
    """Fraction of the top-k results that are in the relevant set."""
    if k == 0:
        return 0.0
    top = returned[:k]
    if not top:
        return 0.0
    return sum(1 for r in top if r in relevant) / k


def recall_at_k(returned, relevant, k):
    """Fraction of relevant items that appear in the top-k results."""
    if not relevant:
        return 0.0
    top = set(returned[:k])
    return sum(1 for r in relevant if r in top) / len(relevant)


def reciprocal_rank(returned, relevant):
    """1/rank of the first relevant hit; 0 if none retrieved."""
    for i, rowid in enumerate(returned, start=1):
        if rowid in relevant:
            return 1.0 / i
    return 0.0


def average(values):
    """Arithmetic mean; 0.0 for empty input."""
    return sum(values) / len(values) if values else 0.0


# ---------------------------------------------------------------------------
# Configurations under test
# ---------------------------------------------------------------------------

# Class table configurations -------------------------------------------------
CLASS_CONFIGS = [
    # label, tokenizer, bm25 weights (name, brief)
    ("unicode61 default,        bm25 3.0/1.0",  "unicode61",                              (3.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 3.0/1.0",  "unicode61 tokenchars '_'",               (3.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 2.0/1.0",  "unicode61 tokenchars '_'",               (2.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 4.0/1.0",  "unicode61 tokenchars '_'",               (4.0, 1.0)),
    ("trigram,                  bm25 3.0/1.0",  "trigram",                                 (3.0, 1.0)),
    ("porter unicode61 tc=_,    bm25 3.0/1.0",  "porter unicode61 tokenchars '_'",        (3.0, 1.0)),
]

# Member table configurations ------------------------------------------------
MEMBER_CONFIGS = [
    # label, tokenizer, bm25 weights (name, signature, description)
    ("unicode61 default,        bm25 3.0/2.0/1.0",  "unicode61",                              (3.0, 2.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 3.0/2.0/1.0",  "unicode61 tokenchars '_'",               (3.0, 2.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 2.0/2.0/1.0",  "unicode61 tokenchars '_'",               (2.0, 2.0, 1.0)),
    ("unicode61 tokenchars=_,   bm25 4.0/2.0/1.0",  "unicode61 tokenchars '_'",               (4.0, 2.0, 1.0)),
    ("trigram,                  bm25 3.0/2.0/1.0",  "trigram",                                 (3.0, 2.0, 1.0)),
    ("porter unicode61 tc=_,    bm25 3.0/2.0/1.0",  "porter unicode61 tokenchars '_'",        (3.0, 2.0, 1.0)),
]

# Tutorial table configurations ----------------------------------------------
TUTORIAL_CONFIGS = [
    # label, tokenizer, bm25 weights (title, heading_path, content)
    ("unicode61 default,        bm25 3.0/2.0/1.0",  "unicode61",                  (3.0, 2.0, 1.0)),
    ("unicode61 default,        bm25 2.0/2.0/1.0",  "unicode61",                  (2.0, 2.0, 1.0)),
    ("unicode61 default,        bm25 4.0/2.0/1.0",  "unicode61",                  (4.0, 2.0, 1.0)),
    ("porter unicode61,         bm25 3.0/2.0/1.0",  "porter unicode61",           (3.0, 2.0, 1.0)),
    ("trigram,                  bm25 3.0/2.0/1.0",  "trigram",                    (3.0, 2.0, 1.0)),
]


# ---------------------------------------------------------------------------
# Evaluation loops
# ---------------------------------------------------------------------------

def evaluate_table(table_name, builder, configs, queries):
    """Run every config × every query for a single FTS table.

    Returns a list of {config, by_bucket, overall} dicts ready for serialization.
    """
    results = []
    for label, tokenizer, weights in configs:
        con = sqlite3.connect(":memory:")
        builder(con, tokenizer)

        per_query = []
        for bucket, raw_q, relevant in queries:
            match_expr = fts5_match_query(raw_q, tokenizer.split()[0])
            returned = run_search(con, table_name, match_expr, weights, LIMIT)
            per_query.append({
                "bucket": bucket,
                "query": raw_q,
                "relevant": list(relevant),
                "returned": returned,
                "p@1": precision_at_k(returned, set(relevant), 1),
                "p@3": precision_at_k(returned, set(relevant), 3),
                "p@5": precision_at_k(returned, set(relevant), 5),
                "r@1": recall_at_k(returned, set(relevant), 1),
                "r@3": recall_at_k(returned, set(relevant), 3),
                "r@5": recall_at_k(returned, set(relevant), 5),
                "mrr": reciprocal_rank(returned, set(relevant)),
                "zero_hit": len(returned) == 0,
            })

        # Aggregate overall
        overall = {
            "p@1": average([q["p@1"] for q in per_query]),
            "p@3": average([q["p@3"] for q in per_query]),
            "p@5": average([q["p@5"] for q in per_query]),
            "r@1": average([q["r@1"] for q in per_query]),
            "r@3": average([q["r@3"] for q in per_query]),
            "r@5": average([q["r@5"] for q in per_query]),
            "mrr": average([q["mrr"] for q in per_query]),
            "zero_hit_count": sum(1 for q in per_query if q["zero_hit"]),
            "n_queries": len(per_query),
        }

        # Aggregate by bucket
        buckets = {}
        for q in per_query:
            buckets.setdefault(q["bucket"], []).append(q)
        by_bucket = {
            b: {
                "p@3": average([q["p@3"] for q in qs]),
                "r@3": average([q["r@3"] for q in qs]),
                "mrr": average([q["mrr"] for q in qs]),
                "zero_hit_count": sum(1 for q in qs if q["zero_hit"]),
                "n_queries": len(qs),
            }
            for b, qs in buckets.items()
        }

        results.append({
            "config": label,
            "tokenizer": tokenizer,
            "weights": list(weights),
            "overall": overall,
            "by_bucket": by_bucket,
            "per_query": per_query,
        })
        con.close()
    return results


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def markdown_table_for(table_name, results):
    """Build a markdown comparison table for the given FTS table's results."""
    lines = []
    lines.append(f"### {table_name}")
    lines.append("")
    lines.append("| Configuration | P@1 | P@3 | R@3 | R@5 | MRR | 0-hit |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for r in results:
        o = r["overall"]
        lines.append(
            f"| `{r['config']}` "
            f"| {o['p@1']:.3f} | {o['p@3']:.3f} | {o['r@3']:.3f} "
            f"| {o['r@5']:.3f} | {o['mrr']:.3f} | {o['zero_hit_count']}/{o['n_queries']} |"
        )
    lines.append("")

    # By-bucket MRR breakdown
    bucket_names = sorted({b for r in results for b in r["by_bucket"]})
    lines.append("#### MRR by query bucket")
    lines.append("")
    header = "| Configuration | " + " | ".join(bucket_names) + " |"
    sep = "|---|" + "|".join("---:" for _ in bucket_names) + "|"
    lines.append(header)
    lines.append(sep)
    for r in results:
        row = [f"`{r['config']}`"]
        for b in bucket_names:
            v = r["by_bucket"].get(b, {}).get("mrr", 0.0)
            row.append(f"{v:.3f}")
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    return "\n".join(lines)


def main():
    """Run all three tables × all configurations and dump JSON + markdown."""
    out = {
        "sqlite_version": sqlite3.sqlite_version,
        "classes": evaluate_table("classes_fts", build_classes, CLASS_CONFIGS, CLASS_QUERIES),
        "members": evaluate_table("members_fts", build_members, MEMBER_CONFIGS, MEMBER_QUERIES),
        "tutorials": evaluate_table("tutorials_fts", build_tutorials, TUTORIAL_CONFIGS, TUTORIAL_QUERIES),
    }

    json_path = RESULT_DIR / "results.json"
    json_path.write_text(json.dumps(out, indent=2), encoding="utf-8")

    md_lines = [
        "# FTS5 tokenizer / BM25 A/B results",
        "",
        f"SQLite version: `{out['sqlite_version']}`",
        "",
        "Corpus: hand-curated Godot 4 sample (25 classes, 27 members, 15 tutorial chunks).",
        f"Queries: {len(CLASS_QUERIES)} class + {len(MEMBER_QUERIES)} member + {len(TUTORIAL_QUERIES)} tutorial.",
        "",
        markdown_table_for("classes_fts (name, brief)", out["classes"]),
        markdown_table_for("members_fts (name, signature, description)", out["members"]),
        markdown_table_for("tutorials_fts (title, heading_path, content)", out["tutorials"]),
    ]
    (RESULT_DIR / "results.md").write_text("\n".join(md_lines), encoding="utf-8")

    print(f"wrote {json_path}")
    print(f"wrote {RESULT_DIR / 'results.md'}")


if __name__ == "__main__":
    main()
