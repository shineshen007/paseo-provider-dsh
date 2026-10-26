/**
 * Newline-delimited JSON-RPC 2.0 transport for the Paseo <-> DSH bridge channel.
 *
 * The channel rides stdin/stdout of a dedicated `dsh` child process. stdout is
 * therefore protocol-only: the bridge must never log to stdout (it uses stderr,
 * which the host writes to its own log). This mirrors the discipline DSH's own
 * `@deepseek-ai/dsh-sdk-jsonrpc-server` follows, which is why the same
 * transport shape is safe here.
 *
 * The implementation is dependency-free and deliberately small: the Paseo
 * plugin package must not pull third-party runtime dependencies into the Paseo
 * daemon's plugin host, and the bridge must stay loadable inside a DSH profile
 * whose module resolution belongs to DSH.
 */

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** One JSON-RPC request frame. */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

/** One JSON-RPC success response frame. */
export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result: unknown;
}

/** One JSON-RPC failure response frame. */
export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** One JSON-RPC notification frame (no id). */
export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcSuccess | JsonRpcError | JsonRpcNotification;

/** JSON-RPC error codes used by this channel. */
export const RPC_ERROR = {
  /** Malformed frame, unknown method, or unusable params. */
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** The bridge does not implement a negotiated feature. */
  unsupported: -32001,
  /** A caller-correctable domain refusal (unknown session, writer held, …). */
  domain: -32002,
} as const;

/** A domain refusal the Paseo plugin should surface as a user-visible error. */
export class BridgeError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface JsonRpcPeerOptions {
  input: Readable;
  output: Writable;
  /** Dispatch one request. Throwing produces an error frame. */
  onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  /** Observe a frame that failed to parse, for logging. */
  onMalformed?(line: string, error: unknown): void;
  /** Called when the peer input closes. */
  onClose?(): void;
}

/**
 * A bidirectional JSON-RPC peer over two byte streams.
 *
 * Frames are newline-delimited JSON. A single in-flight request per id is
 * assumed; the bridge is the server side and Paseo the client, so id collisions
 * are impossible by construction. Requests are dispatched concurrently: a slow
 * turn must not block a cancel or an approval answer arriving behind it.
 */
export class JsonRpcPeer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number | string, (frame: JsonRpcFrame) => void>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private nextId = 1;
  private closed = false;
  private buffer = "";

  private readonly options: JsonRpcPeerOptions;

  constructor(options: JsonRpcPeerOptions) {
    this.options = options;
    options.input.on("data", (chunk: Buffer) => this.onData(chunk));
    options.input.on("end", () => this.shutdown());
    options.input.on("close", () => this.shutdown());
    options.input.on("error", () => this.shutdown());
    options.output.on("error", () => this.shutdown());
  }

  /** Whether the peer still accepts frames. */
  get isOpen(): boolean {
    return !this.closed;
  }

  /** Signal aborted when the peer shuts down, shared with dispatched requests. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Send a notification to the client. Never throws for a closed peer. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
  }

  /** Send one request and resolve with its result. */
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeError(RPC_ERROR.internal, "bridge closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (frame) => {
        if ("error" in frame) {
          const error = frame.error;
          reject(new BridgeError(error.code, error.message, error.data));
        } else if ("result" in frame) {
          resolve(frame.result as T);
        }
      });
      const onAbort = () => {
        this.pending.delete(id);
        reject(new BridgeError(RPC_ERROR.domain, "request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest);
    });
  }

  /** Stop reading and fail outstanding work. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const settle of this.pending.values()) {
      settle({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERROR.internal, message: "bridge closed" },
      } satisfies JsonRpcError);
    }
    this.pending.clear();
    this.options.onClose?.();
  }

  /** Wait for every in-flight dispatch, used by an ordered shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
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
    } catch (error) {
      this.options.onMalformed?.(line, error);
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.options.onMalformed?.(line, new Error("not a JSON-RPC 2.0 frame"));
      return;
    }
    // Response to a request this side issued.
    if ("id" in frame && ("result" in frame || "error" in frame) && !("method" in frame)) {
      const id = frame.id;
      if (typeof id === "number" || typeof id === "string") {
        const settle = this.pending.get(id);
        if (settle !== undefined) {
          this.pending.delete(id);
          settle(frame as unknown as JsonRpcFrame);
        }
      }
      return;
    }
    // Request from the peer.
    if (typeof frame.method === "string" && "id" in frame) {
      const id = typeof frame.id === "number" || typeof frame.id === "string" ? frame.id : null;
      const task = this.dispatch(frame.method, frame.params, id);
      this.inflight.add(task);
      void task.finally(() => this.inflight.delete(task));
      return;
    }
    // Notification from the peer: not expected, recorded as malformed.
    if (typeof frame.method === "string") {
      this.options.onMalformed?.(line, new Error(`unexpected notification ${frame.method}`));
    }
  }

  private async dispatch(method: string, params: unknown, id: number | string | null): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params, this.lifetime.signal);
      this.write({ jsonrpc: "2.0", id, result } satisfies JsonRpcSuccess);
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : RPC_ERROR.internal;
      const message = error instanceof Error ? error.message : String(error);
      const data =
        error instanceof BridgeError ? error.data : error instanceof Error ? (error.stack ?? undefined) : undefined;
      this.write({
        jsonrpc: "2.0",
        id,
        error: data === undefined ? { code, message } : { code, message, data },
      } satisfies JsonRpcError);
    }
  }

  private write(frame: JsonRpcFrame): void {
    if (this.closed) return;
    try {
      this.options.output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      this.shutdown();
    }
  }
}

/** Narrow an unknown JSON value to an indexable record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a required string field from untrusted params. */
export function requireString(params: unknown, field: string, context: string): string {
  if (!isRecord(params)) {
    throw new BridgeError(RPC_ERROR.invalidParams, `${context}: params must be an object`);
  }
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(RPC_ERROR.invalidParams, `${context}: "${field}" must be a non-empty string`);
  }
  return value;
}

/** Read an optional string field from untrusted params. */
export function optionalString(params: unknown, field: string): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read an optional boolean field from untrusted params. */
export function optionalBoolean(params: unknown, field: string): boolean | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[field];
  return typeof value === "boolean" ? value : undefined;
}

/** Read an optional finite number field from untrusted params. */
export function optionalNumber(params: unknown, field: string): number | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
