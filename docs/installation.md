# Installation

This document covers installing `godot-mcp` for normal interactive use and for
**offline / air-gapped** environments where the host cannot reach
`api.github.com`, `codeload.github.com`, or HuggingFace.

> Most users do not need offline mode. Skip to the [bottom section](#offline-installation)
> only if your machine is firewalled, on a restricted CI runner, or operating
> behind a corporate proxy that bans runtime fetches.

## Standard installation

```sh
npm install -g godot-mcp
```

Then point your MCP client (Claude Desktop, Cline, etc.) at the `godot-mcp`
binary. The bundled `stable` documentation database ships with the npm
package — no network fetch is needed for the default configuration.

## Configuration

All configuration is via environment variables. See
[DESIGN.md § Configuration](DESIGN.md#configuration) for the full list. The
three env vars relevant to offline operation are:

| Variable               | Purpose                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GODOT_MCP_OFFLINE`    | Set to `1` (or `true`) to disable **all** runtime network calls. Any forbidden call fails fast with exit 2.   |
| `GODOT_DOCS_DB_PATH`   | Absolute path to a pre-built docs `.db` file. Skips version resolution entirely; schema integrity still runs. |
| `GODOT_MCP_MODEL_PATH` | Absolute path to a pre-downloaded embedding-model directory (BGE-small-en-v1.5 ONNX files).                   |

## Offline installation

The procedure has two halves:

1. **On an internet-connected machine**: pre-warm the cache.
2. **On the air-gapped machine**: copy the cache into place and set
   `GODOT_MCP_OFFLINE=1`.

### Step 1 — Pre-warm the cache (internet-connected machine)

This step exists because the bundled `stable` DB may not match the Godot
version you want to ship docs for. If you only need bundled `stable`, skip
straight to step 2 — no pre-warming is needed.

```sh
# 1. Install godot-mcp normally.
npm install -g godot-mcp

# 2. Resolve the docs DB for the version you actually want. Replace 4.5
#    with the X.Y you need. This triggers the network fetch and parse;
#    the result is cached under your OS cache dir.
#
#    NOTE: godot-mcp must be run by an MCP client to trigger ingestion;
#    you cannot drive this from the CLI directly. As a workaround, start
#    the server with your MCP client configured to GODOT_DOCS_VERSION=4.5
#    and issue any docs tool call (e.g. search_docs), then stop it.
GODOT_DOCS_VERSION=4.5 godot-mcp --version  # sanity-check the binary is reachable

# 3. Trigger a tutorial search so the embedding model is downloaded into
#    the HuggingFace cache. (Any docs tool call that hits the tutorial
#    search path works.)
```

After this step the following directories contain the assets you need:

- **Docs DB**: `$XDG_CACHE_HOME/godot-mcp/docs-{version}-v{schema}.db`
  (Linux default: `~/.cache/godot-mcp/`; macOS:
  `~/Library/Caches/godot-mcp/`; Windows: `%LOCALAPPDATA%\godot-mcp\Cache\`).
- **Embedding model**: `~/.cache/huggingface/` (or your `HF_HOME` override).

### Step 2 — Copy assets to the air-gapped machine

Transfer the two cache directories using whatever channel your environment
permits (USB stick, internal artifact server, signed tarball, etc.):

```sh
# On the source machine — package the assets.
tar -czf godot-mcp-cache.tar.gz \
    ~/.cache/godot-mcp/docs-4.5-v1.db \
    ~/.cache/huggingface/

# On the air-gapped machine — install godot-mcp from a pre-downloaded
# tarball (npm pack / artifactory mirror / etc.), then unpack the cache.
npm install -g ./godot-mcp-x.y.z.tgz
mkdir -p ~/.cache
tar -xzf godot-mcp-cache.tar.gz -C /
```

### Step 3 — Configure the air-gapped environment

Set the three env vars in your MCP client config (or shell profile):

```sh
export GODOT_MCP_OFFLINE=1
export GODOT_DOCS_DB_PATH=/path/to/docs-4.5-v1.db
export GODOT_MCP_MODEL_PATH=/path/to/huggingface/hub/models--BAAI--bge-small-en-v1.5
```

`GODOT_DOCS_DB_PATH` is the recommended escape hatch — it skips version
resolution entirely. The alternative (relying on the OS cache dir + setting
`GODOT_DOCS_VERSION=4.5`) works but is fragile: the cache filename includes
a schema version that can change between godot-mcp releases.

### Verification

`godot-mcp --version` exits immediately (it does not start the MCP stdio
transport), so it is safe to use as a quick smoke test. With offline mode
enabled, env-var misconfiguration is caught before the server starts and
exits with code **2** (user error, distinct from exit 1 for runtime
failures).

```sh
# Print the installed version — exits 0 immediately without touching stdin.
godot-mcp --version

# Should exit 0: env vars are valid; offline + no network-requiring version.
GODOT_MCP_OFFLINE=1 godot-mcp --version

# Should exit 2: 'latest' requires a GitHub Tags API call, which is
# forbidden in offline mode.
GODOT_MCP_OFFLINE=1 GODOT_DOCS_VERSION=latest godot-mcp --version
```

The third invocation's error message names the env var combination that
failed and the four ways to resolve it (unset offline, pin to X.Y, use
`GODOT_DOCS_DB_PATH`, or fall back to bundled `stable`).

### What does **not** require network in offline mode

- Loading the bundled `stable` docs DB (it ships in the npm package).
- Loading a DB via `GODOT_DOCS_DB_PATH` (the integrity check is local-only).
- Loading the embedding model via `GODOT_MCP_MODEL_PATH` (local file read).
- All editor tools (`godot_launch_editor`, `godot_run_project`, etc.) —
  these shell out to the local Godot binary and never touch the network.
- All LSP tools — these spawn a local headless Godot and speak TCP to
  `127.0.0.1` only.

### What requires network and is forbidden in offline mode

- GitHub Tags API call (`GODOT_DOCS_VERSION=latest` resolution).
- Codeload tarball fetch (`godotengine/godot` + `godotengine/godot-docs`
  source tarballs for non-bundled versions on cache miss).
- HuggingFace model download (BGE-small-en-v1.5 ONNX files on first use,
  unless `GODOT_MCP_MODEL_PATH` is set).

Each blocked call fails with an `OfflineModeError` naming the specific
operation and the env-var escape hatch for that operation.
