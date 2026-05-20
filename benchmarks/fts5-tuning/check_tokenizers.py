"""Smoke-test: confirm Python's stdlib sqlite3 supports the FTS5 tokenizers
this research uses (unicode61 with tokenchars, porter, trigram)."""

import sqlite3

con = sqlite3.connect(":memory:")
print("sqlite version:", sqlite3.sqlite_version)

con.execute("CREATE VIRTUAL TABLE t_default USING fts5(x)")
print("default unicode61 OK")

con.execute("CREATE VIRTUAL TABLE t_tc USING fts5(x, tokenize=\"unicode61 tokenchars '_'\")")
print("unicode61 tokenchars OK")

con.execute("CREATE VIRTUAL TABLE t_porter USING fts5(x, tokenize=\"porter unicode61\")")
print("porter OK")

con.execute("CREATE VIRTUAL TABLE t_tri USING fts5(x, tokenize=\"trigram\")")
print("trigram OK")
