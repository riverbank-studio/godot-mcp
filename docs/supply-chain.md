# Supply-chain integrity

This document describes how `godot-mcp` defends against compromise of the
upstream Godot source tarballs that the documentation subsystem ingests.
It is intentionally narrow in scope — only the tarball-pinning aspect of
supply-chain integrity (issue #47). Broader supply-chain considerations
(npm dependencies, embedding-model weights, etc.) are tracked separately.

## Threat model

`src/docs/ingest.ts` fetches two source tarballs from `codeload.github.com`:

- `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/{tag}` —
  the engine source, for parsing `doc/classes/*.xml`
- `https://codeload.github.com/godotengine/godot-docs/tar.gz/refs/heads/{branch}` —
  the long-form RST tutorials

Git tags are mutable in principle. Codeload does not serve signed
artifacts. Structural validation (XML file count ≥ 500, `Object.xml`
parses) catches truncation and gross malformation but **not** a malicious
or accidental retag that preserves structural validity.

A compromised tag would otherwise flow through the entire ingestion
pipeline silently, ending up in user-facing search results and in any
shipped pre-built DB.

## Mitigation

Two-layer defense:

### Layer 1: pinned manifest

`data/godot-release-hashes.json` is an in-repo, human-reviewed manifest
keyed by git tag. Each entry records the expected SHA-256 of both
tarballs:

```json
{
  "4.5-stable": {
    "godot": "sha256:0b2c942c79f756da5c94990e06678feaa582ae533b5e126f992a29d1ea8a816c",
    "godot-docs-branch": "4.5",
    "godot-docs": "sha256:6fca979fead904298a24b68482aee17f8acbb6ae8d061df9bdd8be393795122b"
  }
}
```

After each tarball download, `src/docs/integrity.ts:verifyTarballSha`
computes the SHA-256 of the bytes and compares against the manifest. A
mismatch is a **hard failure** (`IntegrityError` with `code:
TARBALL_SHA_MISMATCH` and `exitCode: 2`). The top-level CLI handler in
`index.ts` is expected to surface that as `process.exit(2)` — the
user-error exit class — since the right response is human inspection of
either the upstream tag or the manifest.

The schema is documented at `data/godot-release-hashes.schema.json`.

### Layer 2: observed-SHA recording for unpinned tags

`latest` and any tag without a manifest entry are not blocked. The
ingestion pipeline still computes the SHA-256 and persists it in the
resulting DB's `meta` row (`tarball_sha256` for the engine tarball,
`docs_tarball_sha256` for the docs tarball). `godot_docs_info` (#19)
returns those fields, making cross-user / cross-cache comparison
possible: a downstream compromise becomes detectable as a SHA divergence
between users running the "same" `latest` version on different days.

## Updating the manifest

The manifest is updated only through one of two paths, both human-gated:

1. **Manual PR.** A maintainer fetches the new tarball, computes its
   SHA-256, and PRs the manifest change. Reviewers verify the SHA by
   re-fetching independently.

2. **Auto-republish workflow (#11).** When upstream tags a new stable
   release, the CI workflow opens a PR that updates
   `data/godot-release-hashes.json` _before_ kicking off the rebuild.
   The PR is the human-review gate; the rebuild only runs after merge.

Either way, no automated process is permitted to mutate the manifest in
the same commit as a rebuild artifact — that would defeat the
human-review gate.

## Env override

`GODOT_DOCS_TARBALL_HASH_OVERRIDE` lets users with forks (non-upstream
tarballs) pin a different SHA without editing the in-repo manifest:

```sh
export GODOT_DOCS_TARBALL_HASH_OVERRIDE="godot=sha256:<HEX>,godot-docs=sha256:<HEX>"
```

The override applies to the current process only and replaces the
manifest's expected value for the listed assets. A mismatch against the
override is still a hard failure — the override changes _what_ is pinned,
not _whether_ pinning happens.

A malformed override (bad asset name, bad hash format) is itself an
`IntegrityError` (`code: OVERRIDE_MALFORMED`). Silently falling back to
the manifest would defeat the user's intent to verify.

## Computing the SHA-256 of a tarball

For maintainers updating the manifest manually:

```sh
curl -sL -o /tmp/godot-4.5.tar.gz \
  https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/4.5-stable
sha256sum /tmp/godot-4.5.tar.gz
# 0b2c942c79f756da5c94990e06678feaa582ae533b5e126f992a29d1ea8a816c  /tmp/godot-4.5.tar.gz
```

Prepend `sha256:` to the hex output when writing it into the manifest.

The hash is taken over the exact bytes returned by codeload — do not
`tar -tzvf` first; the gzipped tarball stream is what we pin.

## Why not GitHub release artifacts or signed tags?

The Godot engine project does not currently publish signed tags or
detached signatures over the source tarball. GitHub release assets exist
for binary builds but not for sources. Codeload tarballs are the
canonical entry point for source ingestion (used by package managers,
git-archive consumers, and tkmct/godot-doc-mcp), so pinning the codeload
SHA is the right level of granularity.

If upstream adds signing in the future (proposed in
[godot-proposals#1234](https://github.com/godotengine/godot-proposals)),
this layer is additive — a signature check would slot in alongside the
SHA pin, not replace it.

## Related issues

- **#47** — this work (manifest + verification helper).
- **#6** — docs ingestion pipeline that imports `verifyTarballSha`.
- **#11** — auto-republish CI that updates the manifest as a gated step.
- **#19** — `godot_docs_info` tool that exposes the recorded SHAs.
- **#5** — offline DB override path; pinning lets users trust a sidecar DB.
