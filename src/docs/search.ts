/**
 * FTS5 query helpers shared by the docs-tools leaves (#14, #16, #17).
 *
 * The helpers exist for two reasons:
 *
 *   1. **Safety.** User-supplied query strings cannot be inlined into
 *      an FTS5 MATCH expression directly — characters like `"`, `*`, `(`,
 *      `NEAR`, and `AND` would parse as FTS5 operators. We tokenize on
 *      non-word characters and wrap each token in a double-quoted string
 *      literal (with embedded quotes doubled per SQL/FTS5 convention).
 *      The result parses as a phrase per token, never as an operator
 *      keyword.
 *
 *   2. **Uniformity.** Every leaf builds its MATCH expression the same
 *      way: tokens AND-joined with a trailing `*` prefix wildcard.
 *      This is the strategy validated by docs/research/fts5-tokenizer-bm25.md
 *      (#39) against the recommended production tokenizers
 *      (`unicode61 tokenchars '_'` for classes/members, `porter unicode61`
 *      for tutorials). Trigram is explicitly out of scope for v1.
 *
 * What this module is NOT
 * -----------------------
 *
 *   - It does not execute SQL. The caller passes the MATCH string into
 *     a prepared statement. (FTS5 MATCH RHS is data, not SQL — but the
 *     escaping still matters: an unbalanced quote or a stray reserved
 *     word would raise `SQLITE_ERROR` at query time.)
 *   - It does not pick BM25 weights. Those are per-table choices and
 *     belong in each leaf's SQL string.
 *   - It does not do snippet/highlight rendering. Leaves call the FTS5
 *     `snippet()` / `highlight()` auxiliary functions in their own SQL.
 *
 * Reference: SQLite FTS5 § 3.1 (full-text query syntax),
 * <https://www.sqlite.org/fts5.html#full_text_query_syntax>.
 */

/**
 * Wrap a single token in an FTS5 double-quoted string literal. Embedded
 * double quotes are doubled (`"foo\"bar"` → `"foo""bar"`), matching the
 * SQLite string-literal convention that FTS5 inherits.
 *
 * Use this only on tokens already split out of the user query — wrapping
 * a multi-word string produces a phrase match for that exact phrase,
 * which is not what the prefix-AND strategy wants.
 *
 * @example
 *   escapeFtsToken("add_child")     // → '"add_child"'
 *   escapeFtsToken('foo"bar')       // → '"foo""bar"'
 */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Pre-compiled splitter. Matches one or more characters that the
 * `unicode61 tokenchars '_'` tokenizer would treat as token separators —
 * i.e. anything that's neither a word character (`[A-Za-z0-9]`) nor an
 * underscore. JavaScript's `\w` already includes `_`, but spelling it
 * out makes the intent obvious.
 *
 * Note: this is a JS-side split, not the actual SQLite tokenizer. We
 * approximate so the AND-joined prefix expression has the right shape;
 * FTS5 retokenizes the RHS of MATCH internally.
 */
const TOKEN_SPLIT_RE = /[^A-Za-z0-9_]+/;

/**
 * Split a free-text query into tokens. Returns an empty array for
 * `undefined`, empty, or whitespace-only input — the caller decides
 * whether that's an error or an "all matches" intent.
 *
 * Tokens are NOT lowercased here. The FTS5 `unicode61` tokenizer
 * lowercases on both index and query sides, so the case of tokens we
 * pass into MATCH doesn't affect retrieval.
 */
export function tokenizeQuery(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0);
}

/**
 * Build the FTS5 MATCH expression for a prefix-AND search:
 *
 *   tokenizeQuery(q) → ['"t1" *', '"t2" *', ...] joined by ` AND `
 *
 * Returns `null` when the query tokenizes to nothing. The caller decides
 * the semantics of empty: `godot_search_api` errors out if there are no
 * filters either, while `godot_search_tutorials` errors directly.
 *
 * Prefix matching is per-token (the `*` follows each quoted token rather
 * than the whole conjunction). This lets `Anim*` match `AnimationPlayer`
 * etc. without requiring an exact identifier match.
 *
 * @example
 *   buildPrefixMatch("add child")   // → '"add" * AND "child" *'
 *   buildPrefixMatch("add_child")   // → '"add_child" *'
 *   buildPrefixMatch("")            // → null
 */
export function buildPrefixMatch(raw: string | undefined): string | null {
  const tokens = tokenizeQuery(raw);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${escapeFtsToken(t)} *`).join(" AND ");
}

/**
 * Predicate for the empty-query branch of `godot_search_api` (DESIGN.md
 * L79: empty query with no structured filters returns `{results: [],
 * hint}`, not an error). The check is more permissive than
 * `buildPrefixMatch(q) === null` because we want a query that would
 * tokenize to nothing under our splitter — `!!!` for example — to count
 * as "no query" rather than "user typed something".
 */
export function isQueryEffectivelyEmpty(raw: string | undefined): boolean {
  return tokenizeQuery(raw).length === 0;
}
