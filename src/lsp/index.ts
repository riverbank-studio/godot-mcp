/**
 * Public surface of the LSP subsystem.
 *
 * Wave 4 tools (`#9-infra` and its leaves) import from this file rather
 * than reaching into individual modules. The grouping is by concern:
 *
 *   - **Configuration** — env-var parsing.
 *   - **Errors** — categorized failure types for tool-handler `instanceof`
 *     branches.
 *   - **Process management** — spawn lifecycle, port scan.
 *   - **Documents** — lazy `didOpen` + auto-resync.
 *   - **Queue** — 2-priority queue.
 *   - **Client** — the high-level facade tying everything together.
 *
 * The deliberate split between `process.ts` (no LSP knowledge) and
 * `client.ts` (no spawn knowledge) is documented in their headers; this
 * file is the only place callers see the unified surface.
 */

export {
  parseLspEnv,
  parsePositiveInt,
  DEFAULT_LSP_PORT,
  DEFAULT_PORT_SCAN_ATTEMPTS,
  DEFAULT_SPAWN_RESET_MINUTES,
  DEFAULT_DIAGNOSTIC_FIRST_MS,
  DEFAULT_DIAGNOSTIC_STEADY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPAWN_CAP,
  DEFAULT_STAT_POLL_THROTTLE_MS,
} from "./config.js";
export type { LspConfig } from "./config.js";

export {
  LspUnavailableError,
  LspBinaryNotFoundError,
  LspProjectNotFoundError,
  LspProjectPathInvalidError,
  LspPortUnavailableError,
  LspSpawnFailedError,
  LspHandshakeTimeoutError,
  LspHandshakeFailedError,
  LspSpawnCapExhaustedError,
  LspConnectionLostError,
} from "./errors.js";
export type { LspUnavailableReason } from "./errors.js";

export {
  detectProjectRoot,
  detectProjectRootOrThrow,
  validateProjectPath,
  containsProjectFile,
  PROJECT_FILE,
} from "./project-detect.js";

export { isPortFree, findAvailablePort, LOOPBACK_HOST } from "./port-scan.js";

export {
  LspRequestQueue,
  RequestTimeoutError,
  INTERACTIVE_METHODS,
  BACKGROUND_METHODS,
  laneFor,
} from "./queue.js";
export type { Lane, EnqueueOptions } from "./queue.js";

export { DocumentTracker, TRACKED_EXTENSIONS, nodeFs } from "./documents.js";
export type {
  DocumentEvent,
  DocumentFs,
  DocumentTrackerOptions,
  StatLike,
} from "./documents.js";

export { LspProcessManager } from "./process.js";
export type { LspProcessHandle, LspProcessManagerOptions } from "./process.js";

export { LspClient, filePathToUri, RECONNECT_BACKOFF_MS } from "./client.js";
export type {
  KnownServerCapabilities,
  LspClientOptions,
  LspDiagnostic,
  DiagnosticCacheEntry,
} from "./client.js";

export {
  fromLspPosition,
  fromLspRange,
  mapLspErrorToResponse,
  resolveLspContext,
  toLspPosition,
  toLspRange,
  uriToFilePath,
  validateFileInProject,
  withLspClient,
} from "./tool-helpers.js";
export type {
  LspClientLike,
  LspPosition,
  LspProvider,
  LspRange,
  LspToolContext,
  WirePosition,
  WireRange,
} from "./tool-helpers.js";
