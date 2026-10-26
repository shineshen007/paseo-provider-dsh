/**
 * Paseo-side client for the bridge channel.
 *
 * This is the mirror of `dsh-bridge/src/rpc.ts`: newline-delimited JSON-RPC 2.0
 * over a socket. It is deliberately a separate implementation rather than a
 * shared import because the two halves ship independently — the bridge is
 * installed into a DSH profile and the plugin into the Paseo daemon — and a
 * shared module would couple their upgrade cycles.
 *
 * Behaviour worth calling out:
 *
 * - Notifications are dispatched to registered handlers, and a handler failure
 *   is contained: one bad frame must not kill a live turn.
 * - Requests time out, because a wedged DSH host must not wedge the Paseo UI.
 * - The client reports channel loss through `onClose` so the provider can emit a
 *   `session.runtime_failed` event and let Paseo show a reconnect affordance.
 */

import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { BridgeNotificationMap, BridgeRequestMap } from "../shared/wire.ts";

/** JSON-RPC error codes, mirrored from the bridge. */
export const RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupported: -32001,
  domain: -32002,
} as const;

/** A failure reported by the bridge. */
export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Options for the client. */
export interface BridgeClientOptions {
  socket: Socket;
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Called once when the channel is lost. */
  onClose?(reason: string): void;
  /** Called for a notification whose handler threw. */
  onHandlerError?(method: string, error: unknown): void;
}

type NotificationHandler = (params: unknown) => void;

/**
 * One request/response + notification client over a socket.
 *
 * Requests may be issued concurrently: approval answers and cancellation travel
 * on the same channel as prompts, and a slow prompt must not block them.
 */
export class BridgeClient {
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  private readonly options: BridgeClientOptions;

  constructor(options: BridgeClientOptions) {
    this.options = options;
    options.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    options.socket.on("close", () => this.fail("channel closed"));
    options.socket.on("error", (error: Error) => this.fail(`channel error: ${error.message}`));
    options.socket.on("end", () => this.fail("channel ended"));
  }

  /** Whether the channel still accepts work. */
  get isOpen(): boolean {
    return !this.closed;
  }

  /** Register a notification handler; returns a disposer. */
  on<K extends keyof BridgeNotificationMap>(method: K, handler: (params: BridgeNotificationMap[K]) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(handler as NotificationHandler);
    this.handlers.set(method, set);
    return () => {
      const current = this.handlers.get(method);
      current?.delete(handler as NotificationHandler);
      if (current?.size === 0) this.handlers.delete(method);
    };
  }

  /** Send one request and await its result. */
  request<K extends keyof BridgeRequestMap>(
    method: K,
    params: BridgeRequestMap[K]["params"],
    timeoutMs = this.options.timeoutMs ?? 120_000,
  ): Promise<BridgeRequestMap[K]["result"]> {
    if (this.closed) {
      return Promise.reject(new BridgeRpcError(RPC_ERROR.internal, "bridge channel is closed"));
    }
    const id = this.nextId++;
    return new Promise<BridgeRequestMap[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRpcError(RPC_ERROR.internal, `bridge request timed out: ${String(method)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as BridgeRequestMap[K]["result"]),
        reject,
        timer,
      });
      try {
        this.options.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Close the channel and reject outstanding requests. */
  close(reason = "closed by plugin"): void {
    this.fail(reason);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeRpcError(RPC_ERROR.internal, `bridge channel lost: ${reason}`));
      this.pending.delete(id);
    }
    this.options.onClose?.(reason);
    try {
      this.options.socket.destroy();
    } catch {
      // Already destroyed.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const body = frame as {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (typeof body.method === "string") {
      const handlers = this.handlers.get(body.method);
      if (handlers === undefined) return;
      for (const handler of handlers) {
        try {
          handler(body.params);
        } catch (error) {
          this.options.onHandlerError?.(body.method, error);
        }
      }
      return;
    }
    if (typeof body.id !== "number") return;
    const entry = this.pending.get(body.id);
    if (entry === undefined) return;
    this.pending.delete(body.id);
    clearTimeout(entry.timer);
    if (body.error !== undefined) {
      entry.reject(new BridgeRpcError(body.error.code ?? RPC_ERROR.internal, body.error.message ?? "bridge error", body.error.data));
      return;
    }
    entry.resolve(body.result);
  }
}
