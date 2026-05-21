# Release playbook

This document covers the release pipeline for `godot-mcp` and the rollback
procedures for when something goes wrong.

It is the human-facing companion to two workflows:

- [.github/workflows/release.yml](../.github/workflows/release.yml) — manual,
  tag-triggered v1 release path.
- [.github/workflows/auto-republish.yml](../.github/workflows/auto-republish.yml)
  — scheduled poll that auto-publishes to the `canary` dist-tag when a new
  Godot release is hash-verified, with an opt-in promotion path to `latest`.

Both workflows publish via **GitHub Actions OIDC + npm Trusted Publishing** with
Sigstore-signed provenance (`npm publish --provenance`). The maintainer's local
machine never publishes directly. There is no `NPM_TOKEN` secret.

---

## Cutting a manual release

1. Land all changes on `main`. Make sure CI is green.
2. Bump `package.json` `version` in a normal PR. Merge it.
3. From `main`, tag the commit:

   ```bash
   git pull --ff-only
   git tag -a "v$(node -p "require('./package.json').version")" -m "vX.Y.Z"
   git push origin "v$(node -p "require('./package.json').version")"
   ```

4. Pushing the tag triggers `.github/workflows/release.yml`. Watch the run.
   The `publish-latest` job runs inside the `npm-release` environment — a
   required reviewer must approve it.
5. After approval, the workflow:
   - Runs the full build + test + lint suite against Godot.
   - Publishes to npm with `--provenance` and the default `latest` dist-tag.
   - Creates a GitHub Release with auto-generated notes.

If `publish-latest` fails after the `npm publish` step succeeds, **do not
re-run the workflow** — npm rejects re-publishing the same version. Go to the
rollback section below.

---

## Auto-republish (Godot release pipeline)

The scheduled `auto-republish.yml` polls
[godotengine/godot-builds Releases](https://github.com/godotengine/godot-builds/releases)
once a day. When it finds a new stable tag, it:

1. **Detects** the new tag and checks `data/godot-release-hashes.json` for a
   matching SHA entry. If the manifest is missing the tag, the run **skips**
   with a warning — a separate, human-reviewed PR (managed by issue #47) must
   land the manifest update before any auto-republish happens.
2. **Builds + tests** against that Godot tag in an isolated runner.
3. **Hash-verifies** by running ingestion in strict mode
   (`GODOT_DOCS_FAILURE_THRESHOLD_PERCENT=0`). Any SHA mismatch fails the run.
4. **Publishes** the resulting tarball as
   `godot-mcp@<base>-canary.<godot-tag>` to the `canary` dist-tag with
   `--provenance`.
5. **Smoke-tests** the published canary by installing it globally and verifying
   the binary links and parses.

The canary is **never** auto-promoted to `latest`. Promotion is a separate path.

### Promoting a canary to `latest`

Once a canary has been published and a maintainer wants to make it the default
install:

1. Go to **Actions → Auto-republish on Godot release → Run workflow**.
2. Set `promote_to_latest = true`. Leave `force_tag` empty to re-detect, or
   pass the exact Godot tag you want to promote.
3. The run reaches the `promote-to-latest` job, which is gated by the
   `npm-release` GitHub Environment. **A required reviewer must approve.**
4. On approval, the job runs `npm dist-tag add godot-mcp@<version> latest`.
   No re-publish happens — the existing canary tarball becomes `latest`.

This is intentionally a two-step gate: reviewers approve the **promotion**, not
the version number. The version was already validated by the prior canary smoke
test.

---

## Rollback

### A bad version landed on `canary`

This is recoverable without npm registry intervention:

1. Bump and re-publish a corrected canary by re-running the auto-republish
   workflow (it'll skip if the canary version already exists; force a higher
   patch by manually bumping `package.json` on `main` first if the same Godot
   tag needs a different package version).
2. Optionally, point the `canary` dist-tag at a known-good earlier version:

   ```bash
   # From a trusted maintainer machine, with `npm login` done locally.
   # Auth is for read-only metadata + dist-tag manipulation only.
   npm dist-tag add godot-mcp@<known-good-version> canary
   ```

3. As a last resort within 72 hours of publication:

   ```bash
   npm unpublish godot-mcp@<bad-version>
   ```

   Note: npm allows `unpublish` within 72 hours of publication and only if no
   other packages depend on it. After 72 hours, the version is permanent and
   you can only deprecate it (`npm deprecate`).

### A bad version landed on `latest`

**Never `npm unpublish` a `latest`-tagged version.** Users in the wild are
already pinning to that version and an unpublish breaks their installs (npm has
made this harder over the years; the right move is dist-tag manipulation, not
removal).

1. Re-point `latest` at the last known-good version:

   ```bash
   npm dist-tag add godot-mcp@<last-known-good-version> latest
   ```

   Or remove `latest` entirely if no good predecessor exists (forces users to
   pin explicitly):

   ```bash
   npm dist-tag rm godot-mcp latest
   ```

2. Publish a corrected version with a bumped patch number that supersedes the
   bad one. Go through the normal manual release flow.
3. Deprecate the bad version with a clear message:

   ```bash
   npm deprecate godot-mcp@<bad-version> "Use vX.Y.Z+1 instead — see #<issue>"
   ```

### A bad version landed via provenance — supply-chain incident

If you suspect a publish was triggered by a compromised workflow run (e.g.
unexpected actor in the OIDC claim), in addition to the steps above:

1. **Revoke the trusted publisher** at
   <https://www.npmjs.com/package/godot-mcp/access>. Re-publishing then
   requires re-establishing the publisher, which is itself an audit event.
2. Rotate any other secrets the compromised workflow could have seen
   (`GITHUB_TOKEN` is short-lived per run; user-managed secrets, if any, must
   be rotated in repo Settings → Secrets).
3. File a public security advisory via GitHub's advisory UI.
4. Cross-reference the published tarball's provenance attestation
   (`npm view godot-mcp@<bad-version> --json` shows the
   `dist.attestations.provenance` URL) so users can audit which workflow run
   produced the bad tarball.

---

## Verifying a published version's provenance

End users can verify any published version themselves:

```bash
npm install godot-mcp@<version>
npm audit signatures
```

`npm audit signatures` validates the Sigstore bundle against the Rekor
transparency log and confirms the package was built by the expected workflow.
If you ever see an unverified signature for `godot-mcp`, that's an incident —
file an issue immediately.
