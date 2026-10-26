/**
 * Unix-domain-socket carrier for the Paseo <-> DSH bridge channel.
 *
 * Why not stdin/stdout, which is what DSH's own SDK server uses?
 *
 * A bridge host is an ordinary `dsh` profile process, and DSH's own plugins log
 * to stdout through `ctx.logger` (`[llm-deepseek-account] model listing …`, the
 * web app's URL line, and so on). A P0 measurement showed those lines
 * interleaving with protocol frames on stdout. Making the channel robust would
 * mean suppressing every host logger, which is exactly the kind of
 * core-behaviour change this project refuses to make.
 *
 * A socket carrier also earns two functional wins the provider needs:
 *
 * - The DSH host outlives a Paseo daemon restart, so an interrupted turn keeps
 *   running and the plugin reattaches with `session/follow` instead of losing it.
 * - The bridge can accept a reconnect while holding sessions, which is what
 *   makes disconnect recovery (requirement 5) real rather than a restart.
 *
 * Security: the socket lives in a directory created with mode 0700 under the
 * user's own DSH home, so only the owning user can connect. No TCP port is
 * opened, so a Paseo Remote SSH host needs no forwarding.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { JsonRpcPeer, type JsonRpcPeerOptions } from "./rpc.ts";

/** Frames larger than this are refused; a JSON-RPC frame is never this large. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Options for the socket carrier. */
export interface SocketCarrierOptions {
  /** Absolute path of the Unix socket to create. */
  socketPath: string;
  /** Dispatch one request (same contract as the stream peer). */
  onRequest: JsonRpcPeerOptions["onRequest"];
  /** Observe a frame that failed to parse. */
  onMalformed?(line: string, error: unknown): void;
  /** Called when a client connects, with its peer. */
  onConnect?(peer: JsonRpcPeer): void;
  /** Called when the active client disconnects. */
  onDisconnect?(): void;
}

/**
 * Serve the bridge channel on a Unix socket.
 *
 * Only one client is active at a time: a new connection supersedes the previous
 * one, which is what a Paseo daemon restart looks like from this side. The DSH
 * host and its sessions survive that hand-over.
 */
export class SocketCarrier {
  private server: Server | undefined;
  private current: { peer: JsonRpcPeer; socket: Socket } | undefined;
  private closing = false;

  private readonly options: SocketCarrierOptions;

  constructor(options: SocketCarrierOptions) {
    this.options = options;
  }

  /** The peer for the active client, when one is connected. */
  get peer(): JsonRpcPeer | undefined {
    return this.current?.peer;
  }

  /** Create the socket and start accepting clients. */
  async listen(): Promise<void> {
    const { socketPath } = this.options;
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    // Remove a socket left behind by a crashed host; a live host owns the path.
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // A concurrent host may hold it; listen() below reports the real failure.
    }
    const server = createServer({ allowHalfOpen: false }, (socket) => this.accept(socket));
    server.maxConnections = 4;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // EINVAL here almost always means the path exceeded sockaddr_un's
        // sun_path limit (104 bytes on macOS/BSD, 108 on Linux), which the caller
        // can fix by relocating DSH_HOME or the runtime directory.
        if (error.code === "EINVAL") {
          reject(
            new Error(
              `socket path is too long for this platform (${Buffer.byteLength(socketPath)} bytes, limit ~104): ${socketPath}`,
            ),
          );
          return;
        }
        reject(error);
      });
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    // Owner-only access, independent of the parent directory mode.
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Non-POSIX hosts rely on the directory mode.
    }
    this.server = server;
  }

  /** Accept one client, superseding any previous one. */
  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_FRAME_BYTES) {
        this.options.onMalformed?.("<oversized>", new Error("client exceeded the frame budget"));
        socket.destroy();
      }
    });
    this.current?.socket.destroy();

    const peer = new JsonRpcPeer({
      input: socket,
      output: socket,
      onRequest: this.options.onRequest,
      ...(this.options.onMalformed !== undefined ? { onMalformed: this.options.onMalformed } : {}),
      onClose: () => {
        if (this.current?.peer === peer) {
          this.current = undefined;
          this.options.onDisconnect?.();
        }
      },
    });
    this.current = { peer, socket };
    socket.on("error", () => socket.destroy());
    this.options.onConnect?.(peer);
  }

  /** Stop accepting, drop the client, and remove the socket file. */
  async close(): Promise<void> {
    this.closing = true;
    this.current?.peer.shutdown();
    this.current?.socket.destroy();
    this.current = undefined;
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      rmSync(this.options.socketPath, { force: true });
    } catch {
      // Best effort: a stale socket is removed by the next listen().
    }
  }
}
