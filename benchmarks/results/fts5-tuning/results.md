# FTS5 tokenizer / BM25 A/B results

SQLite version: `3.42.0`

Corpus: hand-curated Godot 4 sample (25 classes, 27 members, 15 tutorial chunks).
Queries: 12 class + 16 member + 14 tutorial.

### classes_fts (name, brief)

| Configuration                            |   P@1 |   P@3 |   R@3 |   R@5 |   MRR | 0-hit |
| ---------------------------------------- | ----: | ----: | ----: | ----: | ----: | ----: |
| `unicode61 default,        bm25 3.0/1.0` | 0.833 | 0.444 | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars=_,   bm25 3.0/1.0` | 0.833 | 0.444 | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars=_,   bm25 2.0/1.0` | 0.833 | 0.444 | 0.833 | 0.833 | 0.833 |  2/12 |
| `unicode61 tokenchars=_,   bm25 4.0/1.0` | 0.833 | 0.444 | 0.833 | 0.833 | 0.833 |  2/12 |
| `trigram,                  bm25 3.0/1.0` | 0.750 | 0.417 | 0.750 | 0.750 | 0.750 |  3/12 |
| `porter unicode61 tc=_,    bm25 3.0/1.0` | 0.833 | 0.444 | 0.833 | 0.833 | 0.833 |  2/12 |

#### MRR by query bucket

| Configuration                            | howto | partial | pascal |
| ---------------------------------------- | ----: | ------: | -----: |
| `unicode61 default,        bm25 3.0/1.0` | 1.000 |   0.500 |  1.000 |
| `unicode61 tokenchars=_,   bm25 3.0/1.0` | 1.000 |   0.500 |  1.000 |
| `unicode61 tokenchars=_,   bm25 2.0/1.0` | 1.000 |   0.500 |  1.000 |
| `unicode61 tokenchars=_,   bm25 4.0/1.0` | 1.000 |   0.500 |  1.000 |
| `trigram,                  bm25 3.0/1.0` | 0.250 |   1.000 |  1.000 |
| `porter unicode61 tc=_,    bm25 3.0/1.0` | 1.000 |   0.500 |  1.000 |

### members_fts (name, signature, description)

| Configuration                                |   P@1 |   P@3 |   R@3 |   R@5 |   MRR | 0-hit |
| -------------------------------------------- | ----: | ----: | ----: | ----: | ----: | ----: |
| `unicode61 default,        bm25 3.0/2.0/1.0` | 0.938 | 0.354 | 0.938 | 0.938 | 0.938 |  0/16 |
| `unicode61 tokenchars=_,   bm25 3.0/2.0/1.0` | 0.938 | 0.354 | 0.938 | 0.938 | 0.938 |  0/16 |
| `unicode61 tokenchars=_,   bm25 2.0/2.0/1.0` | 0.938 | 0.354 | 0.938 | 0.938 | 0.938 |  0/16 |
| `unicode61 tokenchars=_,   bm25 4.0/2.0/1.0` | 0.938 | 0.354 | 0.938 | 0.938 | 0.938 |  0/16 |
| `trigram,                  bm25 3.0/2.0/1.0` | 0.750 | 0.292 | 0.750 | 0.750 | 0.750 |  4/16 |
| `porter unicode61 tc=_,    bm25 3.0/2.0/1.0` | 0.938 | 0.375 | 1.000 | 1.000 | 0.969 |  0/16 |

#### MRR by query bucket

| Configuration                                | howto | ident | partial |
| -------------------------------------------- | ----: | ----: | ------: |
| `unicode61 default,        bm25 3.0/2.0/1.0` | 0.750 | 1.000 |   1.000 |
| `unicode61 tokenchars=_,   bm25 3.0/2.0/1.0` | 0.750 | 1.000 |   1.000 |
| `unicode61 tokenchars=_,   bm25 2.0/2.0/1.0` | 0.750 | 1.000 |   1.000 |
| `unicode61 tokenchars=_,   bm25 4.0/2.0/1.0` | 0.750 | 1.000 |   1.000 |
| `trigram,                  bm25 3.0/2.0/1.0` | 0.000 | 1.000 |   1.000 |
| `porter unicode61 tc=_,    bm25 3.0/2.0/1.0` | 0.875 | 1.000 |   1.000 |

### tutorials_fts (title, heading_path, content)

| Configuration                                |   P@1 |   P@3 |   R@3 |   R@5 |   MRR | 0-hit |
| -------------------------------------------- | ----: | ----: | ----: | ----: | ----: | ----: |
| `unicode61 default,        bm25 3.0/2.0/1.0` | 0.714 | 0.262 | 0.714 | 0.714 | 0.714 |  4/14 |
| `unicode61 default,        bm25 2.0/2.0/1.0` | 0.714 | 0.262 | 0.714 | 0.714 | 0.714 |  4/14 |
| `unicode61 default,        bm25 4.0/2.0/1.0` | 0.714 | 0.262 | 0.714 | 0.714 | 0.714 |  4/14 |
| `porter unicode61,         bm25 3.0/2.0/1.0` | 0.929 | 0.381 | 0.905 | 0.905 | 0.929 |  1/14 |
| `trigram,                  bm25 3.0/2.0/1.0` | 0.500 | 0.190 | 0.500 | 0.500 | 0.500 |  7/14 |

#### MRR by query bucket

| Configuration                                | field | howto |
| -------------------------------------------- | ----: | ----: |
| `unicode61 default,        bm25 3.0/2.0/1.0` | 1.000 | 0.636 |
| `unicode61 default,        bm25 2.0/2.0/1.0` | 1.000 | 0.636 |
| `unicode61 default,        bm25 4.0/2.0/1.0` | 1.000 | 0.636 |
| `porter unicode61,         bm25 3.0/2.0/1.0` | 1.000 | 0.909 |
| `trigram,                  bm25 3.0/2.0/1.0` | 1.000 | 0.364 |
