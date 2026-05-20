# Installation

`godot-mcp` is published to npm and installs via `npm`, `pnpm`, or `yarn`.

```bash
npm install -g godot-mcp
```

A `postinstall` hook runs `scripts/preinstall-check.js` which validates that
your platform has prebuilt binaries for every native dependency. On
unsupported platforms it exits with a remediation pointer rather than failing
later with a cryptic `node-gyp` error.

## Supported platforms

| Platform                  | `better-sqlite3` | `sqlite-vec`                                                  | `@huggingface/transformers` | Status                             |
| ------------------------- | ---------------- | ------------------------------------------------------------- | --------------------------- | ---------------------------------- |
| Linux x64 (glibc)         | yes              | yes                                                           | yes                         | Supported                          |
| Linux arm64 (glibc)       | yes              | yes                                                           | yes                         | Supported                          |
| Linux x64 (musl / Alpine) | yes              | no ([PR #199](https://github.com/asg017/sqlite-vec/pull/199)) | no                          | **Unsupported** — preflight blocks |
| Linux arm64 (musl)        | yes              | no                                                            | no                          | **Unsupported** — preflight blocks |
| macOS x64                 | yes              | yes                                                           | yes                         | Supported                          |
| macOS arm64               | yes              | yes                                                           | yes                         | Supported                          |
| Windows x64               | yes              | yes                                                           | yes                         | Supported                          |
| Windows arm64             | yes              | no ([PR #271](https://github.com/asg017/sqlite-vec/pull/271)) | varies                      | **Unsupported** — preflight blocks |

The source of truth for this matrix is
[DESIGN.md § Native dependencies](./DESIGN.md#native-dependencies). The
preflight script encodes the same decision table.

## Unsupported platforms

### Alpine / musl Linux

The official Node Alpine image (`node:24-alpine`) is a common container base,
but `sqlite-vec` has no musl prebuild and `onnxruntime-node` only ships glibc
binaries. `npm install godot-mcp` on Alpine will fail the preflight with:

```
[godot-mcp preflight] ERROR: unsupported platform detected
  (platform=linux arch=x64 libc=musl).
Reason: Alpine / musl Linux is not supported in v1: `sqlite-vec` and
  `onnxruntime-node` have no musl prebuilds ...
Remediation: Switch to a glibc-based image such as `node:bookworm-slim` or
  `node:24-bookworm`. ...
```

**Recommended fix:** switch your base image to `node:24-bookworm-slim`. This
is the cheapest move and is what we test in CI. The published Docker image
(once it lands) will be built on this base.

**To follow upstream progress:** subscribe to
[asg017/sqlite-vec#199](https://github.com/asg017/sqlite-vec/pull/199). Once
that lands and `onnxruntime-node` adds musl prebuilds, this row flips to
supported in a patch release.

### Windows on ARM64

Windows ARM64 is increasingly common (Surface Pro X, Copilot+ PCs) but
`sqlite-vec` has no Windows ARM64 prebuild yet. The preflight will block the
install with a pointer to
[asg017/sqlite-vec#271](https://github.com/asg017/sqlite-vec/pull/271).

**Recommended fix:** run godot-mcp on an x64 Windows host, or use WSL2 with a
glibc distro (Ubuntu, Debian).

## Bypassing the preflight

If you know what you're doing — for example, you've built `sqlite-vec` from
source manually, or you're a distro maintainer packaging this for Nix or
Homebrew — set `GODOT_MCP_PREFLIGHT_SKIP=1` before install:

```bash
GODOT_MCP_PREFLIGHT_SKIP=1 npm install -g godot-mcp
```

This is an **unsupported configuration**. Native-dep runtime errors are on
you. Please do not open issues for installs that bypassed the preflight unless
you can reproduce them on a supported platform.

## CI behavior

In CI environments (where `CI=true` is set automatically by GitHub Actions,
GitLab CI, etc.) the preflight degrades from `exit 1` to `exit 0` with a
warning. This lets a matrix job intentionally exercise the
unsupported-platform path and capture the failure message without aborting
the whole pipeline. See `.github/workflows/ci.yml`'s `preflight-alpine` job
for the canonical example.

## Verifying the preflight manually

After install you can re-run the check anytime:

```bash
npm run preflight
```

Inside the repo, or as a one-off against the installed package:

```bash
node node_modules/godot-mcp/scripts/preinstall-check.js
```

## Related

- [DESIGN.md § Native dependencies](./DESIGN.md#native-dependencies) — full
  context for why these platforms are unsupported.
- [Issue #43](https://github.com/riverbank-studio/godot-mcp/issues/43) —
  original tracking issue for this preflight.
