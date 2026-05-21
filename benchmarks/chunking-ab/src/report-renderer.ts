/**
 * Report renderer for the chunking-config A/B comparison report (#46).
 *
 * Accepts a ComparisonReport and renders it to a Markdown string. The output
 * is intended to be written to `benchmarks/reports/chunking-ab-{ISO-date}.md`.
 *
 * The renderer is a pure function with no I/O so it can be unit-tested without
 * any file-system access.
 */

import type {
  ChunkingConfig,
  ComparisonReport,
  ConfigMetricRow,
  MetricComparison,
  PairedComparison,
  Recommendation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Top-level render function
// ---------------------------------------------------------------------------

/**
 * Renders a ComparisonReport to a Markdown string.
 */
export function renderReport(report: ComparisonReport): string {
  const isoDate = report.generated_at.slice(0, 10); // YYYY-MM-DD
  const sections: string[] = [];

  sections.push(renderHeader(report, isoDate));
  sections.push(renderConfigDescriptions(report.configs));
  sections.push(renderMetricTable(report.metric_rows));
  sections.push(
    renderPairedComparisons(report.paired_comparisons, report.configs),
  );
  sections.push(renderRecommendation(report.recommendation, report.configs));
  sections.push(renderFooter(report));

  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/** Renders the report header (title + run metadata). */
function renderHeader(report: ComparisonReport, isoDate: string): string {
  const lines: string[] = [];

  lines.push(`# Chunking-Config A/B Comparison Report — ${isoDate}`);
  lines.push("");
  lines.push(
    "**Issue:** [#46 — Chunking-config A/B comparison report](https://github.com/riverbank-studio/godot-mcp/issues/46)",
  );
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push(`**Dataset:** tutorial-retrieval/${report.dataset_version}`);
  lines.push(`**Splits:** ${report.splits_included.join(", ")}`);
  lines.push(`**Configs tested:** ${report.configs.length}`);

  if (report.dry_run) {
    lines.push("");
    lines.push(
      "> **DRY-RUN MODE** — pipeline stubs active. Metrics are not meaningful. " +
        "Live runs require deps [#6](https://github.com/riverbank-studio/godot-mcp/issues/6) " +
        "+ [#7](https://github.com/riverbank-studio/godot-mcp/issues/7) to merge.",
    );
  }

  return lines.join("\n");
}

/** Renders the config descriptions table. */
function renderConfigDescriptions(configs: ChunkingConfig[]): string {
  const lines: string[] = [];
  lines.push("## Configurations");
  lines.push("");
  lines.push("| ID | Label | Strategy | Soft limit | Hard cap | Notes |");
  lines.push("|:---|:------|:---------|:----------:|:--------:|:------|");

  for (const c of configs) {
    const notes = c.notes ?? "";
    const extra: string[] = [];
    if (c.always_split_h3) extra.push("always-split-H3");
    if (c.window_overlap_tokens !== undefined)
      extra.push(`overlap=${c.window_overlap_tokens}t`);
    if (c.embedding_model_override)
      extra.push(`embed=${c.embedding_model_override}`);
    const notesCol = [notes, ...extra].filter(Boolean).join("; ");
    lines.push(
      `| \`${c.id}\` | ${c.label} | ${c.strategy} | ${c.soft_token_limit} | ${c.hard_token_cap} | ${notesCol} |`,
    );
  }

  return lines.join("\n");
}

/** Renders the per-config metric summary table. */
function renderMetricTable(rows: ConfigMetricRow[]): string {
  const lines: string[] = [];
  lines.push("## Per-Config Metrics");
  lines.push("");
  lines.push(
    "Metrics from #32 harness. `full_corr.` = Part B full correctness; " +
      "`—` = Part B skipped. Run count: 1 per config (single run; see [Limitations](#limitations)).",
  );
  lines.push("");
  lines.push(
    "| Config | Recall@1 | Recall@5 | MRR | Full corr. | Chunks | Mean t | p95 t | > cap | Run time |",
  );
  lines.push(
    "|:-------|:--------:|:--------:|:---:|:----------:|-------:|-------:|------:|------:|:--------:|",
  );

  for (const r of rows) {
    const fullCorr =
      r.full_correctness !== null ? pct(r.full_correctness) : "—";
    const overCap = r.over_hard_cap > 0 ? `**${r.over_hard_cap}**` : "0";
    lines.push(
      `| \`${r.config_id}\` | ${pct(r.recall_at_1)} | ${pct(r.recall_at_5)} | ${r.mrr.toFixed(4)} | ${fullCorr} | ${r.total_chunks} | ${r.mean_tokens.toFixed(0)} | ${r.p95_tokens} | ${overCap} | ${formatMs(r.run_duration_ms)} |`,
    );
  }

  return lines.join("\n");
}

/** Renders a section for each paired comparison. */
function renderPairedComparisons(
  comparisons: PairedComparison[],
  configs: ChunkingConfig[],
): string {
  if (comparisons.length === 0) {
    return "## Paired Comparisons\n\n_No comparisons available._";
  }

  const configMap = new Map(configs.map((c) => [c.id, c]));
  const sections: string[] = ["## Paired Comparisons"];

  for (const c of comparisons) {
    const baselineLabel = configMap.get(c.baseline_id)?.label ?? c.baseline_id;
    const challengerLabel =
      configMap.get(c.challenger_id)?.label ?? c.challenger_id;

    sections.push(
      `### ${c.challenger_id} vs ${c.baseline_id}` +
        ` (${challengerLabel} vs ${baselineLabel})`,
    );
    sections.push("");
    sections.push(`**Overall winner:** ${formatWinner(c.overall_winner)}`);
    sections.push("");
    sections.push(`> ${c.summary}`);
    sections.push("");

    // Part A table
    sections.push("**Part A — Retrieval**");
    sections.push("");
    sections.push("| Metric | Baseline | Challenger | Delta | Direction |");
    sections.push("|:-------|:--------:|:----------:|:-----:|:---------:|");
    sections.push(renderMetricRow("Recall@1", c.part_a.recall_at_1, true));
    sections.push(renderMetricRow("Recall@5", c.part_a.recall_at_5, true));
    sections.push(renderMetricRow("MRR", c.part_a.mrr, true));
    sections.push("");

    // Per-category
    const catKeys = Object.keys(c.part_a.recall_at_5_by_category);
    if (catKeys.length > 0) {
      sections.push("**Recall@5 by Category**");
      sections.push("");
      sections.push("| Category | Baseline | Challenger | Delta | Direction |");
      sections.push("|:---------|:--------:|:----------:|:-----:|:---------:|");
      for (const cat of catKeys.sort()) {
        sections.push(
          renderMetricRow(cat, c.part_a.recall_at_5_by_category[cat], true),
        );
      }
      sections.push("");
    }

    // Chunk-length table
    sections.push("**Chunk-Length Distribution**");
    sections.push("");
    sections.push("| Metric | Baseline | Challenger | Delta | Direction |");
    sections.push("|:-------|:--------:|:----------:|:-----:|:---------:|");
    sections.push(
      renderMetricRow("Mean tokens", c.chunk_lengths.mean_tokens, false, 0),
    );
    sections.push(
      renderMetricRow("Median tokens", c.chunk_lengths.median_tokens, false, 0),
    );
    sections.push(
      renderMetricRow("p95 tokens", c.chunk_lengths.p95_tokens, false, 0),
    );
    sections.push(
      renderMetricRow("Over hard cap", c.chunk_lengths.over_hard_cap, false, 0),
    );
    sections.push(
      renderMetricRow(
        "< 100t fraction",
        c.chunk_lengths.under_min_threshold_fraction,
        true,
      ),
    );
    sections.push(
      renderMetricRow("Total chunks", c.chunk_lengths.total_chunks, false, 0),
    );
    sections.push("");

    // Part B table
    if (c.part_b) {
      sections.push("**Part B — Answer Correctness**");
      sections.push("");
      sections.push("| Metric | Baseline | Challenger | Delta | Direction |");
      sections.push("|:-------|:--------:|:----------:|:-----:|:---------:|");
      sections.push(
        renderMetricRow("Full correctness", c.part_b.full_correctness, true),
      );
      sections.push(
        renderMetricRow(
          "Partial correctness",
          c.part_b.partial_correctness,
          true,
        ),
      );
      sections.push(
        renderMetricRow("Mean score (0-2)", c.part_b.mean_score, true, 2),
      );
      sections.push("");
    }
  }

  return sections.join("\n");
}

/** Renders the final recommendation section. */
function renderRecommendation(
  rec: Recommendation,
  configs: ChunkingConfig[],
): string {
  const configMap = new Map(configs.map((c) => [c.id, c]));
  const lines: string[] = [];

  lines.push("## Recommendation");
  lines.push("");

  const verdictBadge = formatVerdictBadge(rec.verdict);
  lines.push(`**Verdict:** ${verdictBadge}`);
  lines.push("");
  lines.push(rec.text);

  if (rec.target_config) {
    const target = configMap.get(rec.target_config);
    if (target) {
      lines.push("");
      lines.push(`**Target config:** \`${target.id}\` — ${target.label}`);
      if (rec.verdict === "switch-to" && !target.notes?.includes("follow-up")) {
        lines.push("");
        lines.push(
          "> If switching to this config, file a follow-up PR to update " +
            "`docs/DESIGN.md` § Ingestion pipeline with the new chunking parameters " +
            "(per issue #46 acceptance criteria).",
        );
      }
    }
  }

  if (rec.tuning_levers.length > 0) {
    lines.push("");
    lines.push("### Tuning Levers Identified");
    lines.push("");
    for (const lever of rec.tuning_levers) {
      lines.push(`- ${lever}`);
    }
  }

  return lines.join("\n");
}

/** Renders the footer with limitations and methodology notes. */
function renderFooter(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("## Limitations");
  lines.push("");
  lines.push(
    "- **Single run per config.** No confidence intervals are available; " +
      "results may vary across runs due to non-deterministic retrieval. " +
      "Re-run with multiple seeds and average to increase confidence.",
  );
  lines.push(
    "- **Train split only** (unless `--splits held-out` was passed). " +
      "Held-out queries are reserved for final eval and were not included here.",
  );

  if (report.dry_run) {
    lines.push(
      "- **Dry-run mode.** All pipeline calls used stubs; zero metrics are from " +
        "real retrieval. This report structure is for scaffolding validation only.",
    );
  }

  lines.push(
    "- **Chunking parameters are recorded but not enforced.** " +
      "Until dep #6 lands, the ingestion pipeline must be rebuilt manually for each config; " +
      "the comparison runner records the config metadata but cannot verify the pipeline used them.",
  );
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "Each config is evaluated using the #32 harness " +
      "(`benchmarks/chunking-quality/`) with the tutorial-retrieval dataset " +
      `(${report.dataset_version}). ` +
      "Recall is computed using page + heading anchor ground-truth (stable across " +
      "chunking configs per issue #32 Wave 2 amendment H3). " +
      "Paired comparisons use absolute deltas; a delta smaller than 0.5pp for rates " +
      "or 5 tokens for counts is treated as equivalent.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `_Report generated by \`benchmarks/chunking-ab/run.mjs\` at ${report.generated_at}._`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Formats a rate (0–1) as a percentage string. */
function pct(val: number): string {
  return `${(val * 100).toFixed(1)}%`;
}

/** Formats a duration in milliseconds to a human-readable string. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Formats an overall_winner value for display. */
function formatWinner(winner: PairedComparison["overall_winner"]): string {
  switch (winner) {
    case "challenger":
      return "Challenger";
    case "baseline":
      return "Baseline";
    case "tie":
      return "Tie";
    case "mixed":
      return "Mixed";
  }
}

/** Formats a recommendation verdict as a Markdown badge-style string. */
function formatVerdictBadge(verdict: Recommendation["verdict"]): string {
  switch (verdict) {
    case "ship-baseline":
      return "`SHIP BASELINE`";
    case "switch-to":
      return "`SWITCH`";
    case "investigate":
      return "`INVESTIGATE`";
    case "insufficient-data":
      return "`INSUFFICIENT DATA`";
  }
}

/** Direction indicator character for metric comparison tables. */
function directionIcon(direction: MetricComparison["direction"]): string {
  switch (direction) {
    case "better":
      return "▲";
    case "worse":
      return "▼";
    case "same":
      return "=";
    case "n/a":
      return "—";
  }
}

/**
 * Renders a single metric comparison row for a Markdown table.
 *
 * @param label - Row label.
 * @param m - MetricComparison to render.
 * @param isRate - If true, format a and b as percentages.
 * @param decimalPlaces - Override decimal places for non-rate numeric values.
 */
function renderMetricRow(
  label: string,
  m: MetricComparison,
  isRate: boolean,
  decimalPlaces = 4,
): string {
  const fmt = (v: number | boolean | "skipped"): string => {
    if (v === "skipped") return "—";
    if (typeof v === "boolean") return v ? "PASS" : "FAIL";
    if (isRate) return pct(v);
    return v.toFixed(decimalPlaces);
  };

  const deltaStr =
    m.delta !== null
      ? isRate
        ? `${m.delta >= 0 ? "+" : ""}${(m.delta * 100).toFixed(1)}pp`
        : `${m.delta >= 0 ? "+" : ""}${m.delta.toFixed(decimalPlaces)}`
      : "—";

  return `| ${label} | ${fmt(m.a)} | ${fmt(m.b)} | ${deltaStr} | ${directionIcon(m.direction)} |`;
}
