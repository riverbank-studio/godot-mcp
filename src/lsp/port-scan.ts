/**
 * Upward TCP port scan for the headless Godot LSP.
 *
 * Per `docs/DESIGN.md` L382 / L405, we scan upward from `GODOT_LSP_PORT` for
 * the first port that successfully binds (loopback). The bind probe is
 * synchronous from the caller's perspective — the returned promise settles
 * once a port has been chosen or {@link LspPortUnavailableError} has been
 * thrown.
 *
 * We probe by **binding a server briefly** rather than connecting. Connect
 * probes have a TOCTOU window where another process snatches the port
 * between our probe and Godot's actual bind; bind probes prove the port is
 * available right now and we release it microseconds before handing the
 * number to Godot. The window is still non-zero, but it's the tightest a
 * userspace TCP scan can get.
 */

import * as net from "node:net";

import { LspPortUnavailableError } from "./errors.js";

/**
 * Loopback host hardcoded per Wave 2 amendment D19. See `config.ts`
 * docstring for the rationale (Godot's LSP has no authentication).
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Probe `port` on `host` by trying to bind a temporary server. Resolves
 * `true` if the bind succeeded (the server is closed before the promise
 * resolves); `false` on `EADDRINUSE` / `EACCES`. Re-throws other errors so
 * exotic failure modes (out-of-fd, ENETDOWN) surface clearly.
 */
export function isPortFree(
  port: number,
  host = LOOPBACK_HOST,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners();
      server.close();
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
      } else {
        reject(err);
      }
    });
    server.once("listening", () => {
      // Close synchronously; the OS releases the port once close completes.
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Scan upward from `startPort` for the first free TCP port. Tries up to
 * `attempts` consecutive ports. Throws {@link LspPortUnavailableError} when
 * the scan exhausts its budget without a hit.
 *
 * @param startPort First port to probe.
 * @param attempts Number of consecutive ports tried; the scan covers
 *   `[startPort, startPort + attempts - 1]`.
 * @param probe Probe function — defaults to {@link isPortFree}. Tests
 *   inject a deterministic stub.
 */
export async function findAvailablePort(
  startPort: number,
  attempts: number,
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const candidate = startPort + i;
    // Clamp at 65535 — if the scan would walk off the high end of the
    // port range we report the scan exhausted rather than handing the
    // caller an invalid port number.
    if (candidate > 65535) {
      break;
    }
    if (await probe(candidate)) {
      return candidate;
    }
  }
  throw new LspPortUnavailableError(startPort, attempts);
}
