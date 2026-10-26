// server/provider.ts
import { negotiateProviderCapabilities, PROVIDER_PROTOCOL_VERSION } from "@getpaseo/plugin/server/provider";

// server/rpc-client.ts
import { StringDecoder } from "node:string_decoder";
var RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupported: -32001,
  domain: -32002
};
var BridgeRpcError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    if (data !== void 0) this.data = data;
  }
};
var BridgeClient = class {
  decoder = new StringDecoder("utf8");
  pending = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  buffer = "";
  nextId = 1;
  closed = false;
  options;
  constructor(options) {
    this.options = options;
    options.socket.on("data", (chunk) => this.onData(chunk));
    options.socket.on("close", () => this.fail("channel closed"));
    options.socket.on("error", (error) => this.fail(`channel error: ${error.message}`));
    options.socket.on("end", () => this.fail("channel ended"));
  }
  /** Whether the channel still accepts work. */
  get isOpen() {
    return !this.closed;
  }
  /** Register a notification handler; returns a disposer. */
  on(method, handler) {
    const set = this.handlers.get(method) ?? /* @__PURE__ */ new Set();
    set.add(handler);
    this.handlers.set(method, set);
    return () => {
      const current = this.handlers.get(method);
      current?.delete(handler);
      if (current?.size === 0) this.handlers.delete(method);
    };
  }
  /** Send one request and await its result. */
  request(method, params, timeoutMs = this.options.timeoutMs ?? 12e4) {
    if (this.closed) {
      return Promise.reject(new BridgeRpcError(RPC_ERROR.internal, "bridge channel is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRpcError(RPC_ERROR.internal, `bridge request timed out: ${String(method)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value),
        reject,
        timer
      });
      try {
        this.options.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  /** Close the channel and reject outstanding requests. */
  close(reason = "closed by plugin") {
    this.fail(reason);
  }
  fail(reason) {
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
    }
  }
  onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }
  onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const body = frame;
    if (typeof body.method === "string") {
      const handlers = this.handlers.get(body.method);
      if (handlers === void 0) return;
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
    if (entry === void 0) return;
    this.pending.delete(body.id);
    clearTimeout(entry.timer);
    if (body.error !== void 0) {
      entry.reject(new BridgeRpcError(body.error.code ?? RPC_ERROR.internal, body.error.message ?? "bridge error", body.error.data));
      return;
    }
    entry.resolve(body.result);
  }
};

// server/host.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
var DEFAULT_PROFILE = "paseo-dsh";
function resolveDshHome(env) {
  const configured = env.DSH_HOME;
  if (configured !== void 0 && configured.trim().length > 0) return configured;
  return join(homedir(), ".dsh");
}
function bridgeRuntimeDir(dshHome) {
  return join(dshHome, "paseo-bridge");
}
var MAX_SOCKET_PATH = 100;
function resolveSocketPath(dshHome, suffix) {
  const candidates = [
    join(bridgeRuntimeDir(dshHome), `b-${suffix}.sock`),
    join(tmpdir(), "dsh-paseo", `b-${suffix}.sock`),
    join("/tmp", `dsh-pb-${suffix}.sock`)
  ];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate) < MAX_SOCKET_PATH) return candidate;
  }
  throw new Error(
    `cannot place the bridge socket within ${MAX_SOCKET_PATH} bytes; set DSH_HOME to a shorter path (tried ${candidates.join(", ")})`
  );
}
function planHost(request, baseEnv) {
  const env = { ...baseEnv, ...request.env };
  const dshHome = resolveDshHome(env);
  const socketPath = resolveSocketPath(dshHome, `${process.pid.toString(36)}-${randomUUID().slice(0, 6)}`);
  const defaultArgs = ["--profile", env.DSH_PASEO_PROFILE ?? DEFAULT_PROFILE, "--port", "0", "--no-open"];
  const command = request.launch?.command ?? "dsh";
  const args = request.launch !== void 0 ? [...request.launch.args, ...defaultArgs] : defaultArgs;
  return {
    command,
    args,
    env: {
      ...env,
      ...request.launch?.env ?? {},
      DSH_HOME: dshHome,
      DSH_PASEO_BRIDGE_SOCKET: socketPath
    },
    socketPath
  };
}
var HostStartError = class extends Error {
  diagnostic;
  constructor(message, diagnostic) {
    super(message);
    this.name = "HostStartError";
    this.diagnostic = diagnostic;
  }
};
async function startHost(plan, options) {
  const timeoutMs = options.timeoutMs ?? 6e4;
  mkdirSync(dirname(plan.socketPath), { recursive: true, mode: 448 });
  const child = spawn(plan.command, [...plan.args], {
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stderrLines = [];
  let exited;
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (line.trim()) options.onStderr?.(`stdout: ${line}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > 200) stderrLines.shift();
      options.onStderr?.(line);
    }
  });
  child.on("error", (error) => {
    stderrLines.push(`spawn error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const closer = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
    }
    const deadline = Date.now() + 8e3;
    while (exited === void 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (exited === void 0) {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
    try {
      rmSync(plan.socketPath, { force: true });
    } catch {
    }
  };
  try {
    const socket = await waitForSocket(plan.socketPath, {
      timeoutMs,
      signal: options.signal,
      exited: () => exited,
      stderr: () => stderrLines.join("\n")
    });
    return { socket, close: closer };
  } catch (error) {
    await closer();
    throw error;
  }
}
async function waitForSocket(socketPath, state) {
  const deadline = Date.now() + state.timeoutMs;
  for (; ; ) {
    if (state.signal?.aborted === true) {
      throw new HostStartError("bridge start aborted", state.stderr());
    }
    const exit = state.exited();
    if (exit !== void 0 && !existsSync(socketPath)) {
      throw new HostStartError(
        `dsh host exited before opening the bridge channel (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        state.stderr()
      );
    }
    if (existsSync(socketPath)) {
      try {
        return await connectSocket(socketPath);
      } catch (error) {
        if (Date.now() > deadline) {
          throw new HostStartError(
            `bridge socket exists but refused a connection: ${error instanceof Error ? error.message : String(error)}`,
            state.stderr()
          );
        }
      }
    }
    if (Date.now() > deadline) {
      throw new HostStartError(
        `dsh host did not open the bridge socket within ${state.timeoutMs}ms`,
        state.stderr()
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, 2e3);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
    const onError = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}
async function probeDsh(request, baseEnv) {
  const command = request.launch?.command ?? "dsh";
  const result = await new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: { ...baseEnv, ...request.launch?.env ?? {} },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout += chunk.toString());
    child.stderr?.on("data", (chunk) => stderr += chunk.toString());
    child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve({ code: null, stdout, stderr: `${stderr}timed out` });
    }, 1e4);
  });
  if (result.code !== 0) {
    return {
      available: false,
      diagnostic: `\`${command} --version\` failed (${result.code === null ? "no exit" : `code ${result.code}`}): ${result.stderr.trim() || "no output"}. Install the DeepSeek Harness CLI or set a launch command for this provider.`
    };
  }
  const version = result.stdout.trim().split("\n")[0] ?? "";
  return { available: true, ...version.length > 0 ? { diagnostic: version } : {} };
}

// shared/wire.ts
var BRIDGE_WIRE_VERSION = 1;

// server/ids.ts
function assistantItemId(dshSessionId, attemptId) {
  return `dsh:${dshSessionId}:assistant:${attemptId}`;
}
function reasoningItemId(dshSessionId, attemptId) {
  return `dsh:${dshSessionId}:reasoning:${attemptId}`;
}
function toolItemId(dshSessionId, toolCallId) {
  return `dsh:${dshSessionId}:tool:${toolCallId}`;
}
function permissionId(dshSessionId, approvalId) {
  return `dsh:${dshSessionId}:permission:${approvalId}`;
}
function questionId(dshSessionId, questionRequestId) {
  return `dsh:${dshSessionId}:question:${questionRequestId}`;
}

// server/mapping.ts
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null) {
        const typed = block;
        if (typed.type === "reasoning" || typed.type === "thinking") return "";
        if (typeof typed.text === "string") return typed.text;
      }
      return "";
    }).join("");
  }
  if (typeof content === "object" && content !== null) {
    const typed = content;
    if (typeof typed.text === "string") return typed.text;
  }
  return "";
}
function reasoningOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block;
    if (typed.type === "reasoning" || typed.type === "thinking") {
      if (typeof typed.text === "string") parts.push(typed.text);
      else if (typeof typed.thinking === "string") parts.push(typed.thinking);
      else if (typeof typed.reasoning === "string") parts.push(typed.reasoning);
    }
  }
  return parts.join("");
}
var SHELL_TOOLS = /* @__PURE__ */ new Set(["bash", "pwsh", "shell", "terminal", "run_command"]);
var READ_TOOLS = /* @__PURE__ */ new Set(["read", "read_file", "fs_read"]);
var EDIT_TOOLS = /* @__PURE__ */ new Set(["edit", "str_replace", "str_replace_editor", "apply_patch", "fs_edit"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "write_file", "fs_write"]);
var SEARCH_TOOLS = /* @__PURE__ */ new Set(["grep", "glob", "search", "fs_search", "find"]);
var FETCH_TOOLS = /* @__PURE__ */ new Set(["web_fetch", "fetch", "webfetch"]);
var SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["subagent", "subagent_fork", "task", "delegate"]);
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function rec(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function parseArguments(raw) {
  if (typeof raw !== "string") return rec(raw) ?? {};
  try {
    const parsed = JSON.parse(raw);
    return rec(parsed) ?? {};
  } catch {
    return { raw };
  }
}
function toJsonValue(value) {
  return value;
}
function toolDetail(toolName, args, output, exitCode, childSessionId) {
  const name = toolName.toLowerCase();
  const command = str(args.command) ?? str(args.cmd) ?? str(args.script);
  if (SHELL_TOOLS.has(name) || command !== void 0) {
    return {
      type: "shell",
      command: command ?? toolName,
      ...str(args.cwd) !== void 0 ? { cwd: str(args.cwd) } : {},
      ...output !== void 0 ? { output } : {},
      ...exitCode !== void 0 ? { exitCode } : {}
    };
  }
  const filePath = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  if (READ_TOOLS.has(name) && filePath !== void 0) {
    return {
      type: "read",
      filePath,
      ...output !== void 0 ? { content: output } : {},
      ...num(args.offset) !== void 0 ? { offset: num(args.offset) } : {},
      ...num(args.limit) !== void 0 ? { limit: num(args.limit) } : {}
    };
  }
  if (EDIT_TOOLS.has(name) && filePath !== void 0) {
    return {
      type: "edit",
      filePath,
      ...str(args.old_string) !== void 0 ? { oldString: str(args.old_string) } : {},
      ...str(args.new_string) !== void 0 ? { newString: str(args.new_string) } : {},
      ...str(args.unified_diff) !== void 0 ? { unifiedDiff: str(args.unified_diff) } : {}
    };
  }
  if (WRITE_TOOLS.has(name) && filePath !== void 0) {
    return {
      type: "write",
      filePath,
      ...str(args.content) !== void 0 ? { content: str(args.content) } : {}
    };
  }
  const query = str(args.pattern) ?? str(args.query) ?? str(args.glob);
  if (SEARCH_TOOLS.has(name) || query !== void 0 && FETCH_TOOLS.has(name) === false) {
    return {
      type: "search",
      query: query ?? toolName,
      toolName: name === "web_search" ? "web_search" : name === "grep" ? "grep" : name === "glob" ? "glob" : "search",
      ...output !== void 0 ? { content: output } : {},
      ...num(args.numMatches) !== void 0 ? { numMatches: num(args.numMatches) } : {}
    };
  }
  const url = str(args.url);
  if (FETCH_TOOLS.has(name) && url !== void 0) {
    return {
      type: "fetch",
      url,
      ...str(args.prompt) !== void 0 ? { prompt: str(args.prompt) } : {},
      ...output !== void 0 ? { result: output } : {}
    };
  }
  if (SUBAGENT_TOOLS.has(name)) {
    return {
      type: "sub_agent",
      ...str(args.subagent_type) !== void 0 ? { subAgentType: str(args.subagent_type) } : {},
      ...str(args.description) !== void 0 ? { description: str(args.description) } : {},
      ...str(args.prompt) !== void 0 ? { description: str(args.prompt) } : {},
      ...childSessionId !== void 0 ? { childSessionId } : {},
      log: output ?? ""
    };
  }
  if (name === "exit_plan_mode") {
    return { type: "plan", text: str(args.plan) ?? output ?? "" };
  }
  if (url !== void 0) {
    return { type: "fetch", url, ...output !== void 0 ? { result: output } : {} };
  }
  return { type: "unknown", input: toJsonValue(args), output: output ?? null };
}
function toolResultOf(data) {
  const message = rec(data.message);
  const content = message?.content;
  const output = textOf(content) || textOf(data.output) || void 0;
  const exitCode = num(data.exitCode) ?? num(rec(data.meta)?.exitCode) ?? null;
  const isError = message?.isError === true || rec(data.error) !== void 0;
  return {
    ...output !== void 0 ? { output } : {},
    exitCode,
    failed: isError
  };
}
function timelineItemsFor(sessionId, event) {
  const data = event.data;
  switch (event.type) {
    case "user/message": {
      const text = textOf(data.content);
      const source = rec(data.source);
      const kind = str(source?.kind);
      if (kind !== void 0 && kind !== "user" && kind !== "user-rpc") return [];
      if (text.length === 0) return [];
      return [{ type: "user_message", id: `dsh:${sessionId}:user:${event.seq}`, text }];
    }
    case "assistant/message": {
      const text = textOf(data.content);
      const reasoning = reasoningOf(data.content);
      const messageId = str(data.messageId) ?? str(data.id) ?? `seq-${event.seq}`;
      const items = [];
      if (reasoning.length > 0) {
        items.push({
          type: "reasoning",
          id: reasoningItemId(sessionId, messageId),
          text: reasoning
        });
      }
      if (text.length > 0) {
        items.push({
          type: "assistant_message",
          id: assistantItemId(sessionId, messageId),
          text,
          messageId
        });
      }
      return items;
    }
    case "tool/call": {
      const name = str(data.name) ?? "tool";
      const callId = str(data.callId) ?? `seq-${event.seq}`;
      const args = parseArguments(data.arguments);
      return [
        {
          type: "tool_call",
          id: toolItemId(sessionId, callId),
          callId,
          name,
          detail: toolDetail(name, args),
          status: "running",
          error: null
        }
      ];
    }
    case "tool/result": {
      const message = rec(data.message);
      const callId = str(message?.toolCallId) ?? str(data.callId);
      if (callId === void 0) return [];
      const name = str(message?.name) ?? "tool";
      const result = toolResultOf(data);
      const args = {};
      return [
        {
          type: "tool_call",
          id: toolItemId(sessionId, callId),
          callId,
          name,
          detail: toolDetail(name, args, result.output, result.exitCode),
          ...result.failed ? { status: "failed", error: result.output ?? "tool failed" } : { status: "completed", error: null }
        }
      ];
    }
    case "todo/write": {
      const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : [];
      const items = todos.map((todo) => {
        const row = rec(todo);
        const text = str(row?.text) ?? str(row?.content) ?? "";
        if (text.length === 0) return void 0;
        const status = str(row?.status);
        return {
          text,
          completed: status === "completed" || row?.completed === true,
          ...status === "pending" || status === "in_progress" || status === "completed" ? { status } : {},
          ...str(row?.activeForm) !== void 0 ? { activeForm: str(row?.activeForm) } : {}
        };
      }).filter((item) => item !== void 0);
      if (items.length === 0) return [];
      return [{ type: "todo", id: `dsh:${sessionId}:todo:${event.seq}`, items }];
    }
    case "compaction/start":
      return [{ type: "compaction", id: `dsh:${sessionId}:compact:${event.seq}`, status: "loading" }];
    case "compaction/end":
    case "compaction/summary":
      return [
        {
          type: "compaction",
          id: `dsh:${sessionId}:compact:${event.seq}`,
          status: "completed",
          trigger: "auto"
        }
      ];
    default:
      return [];
  }
}

// server/provider.ts
var PROVIDER_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "permission",
  "timeline.plugin"
];
var PROVIDER_ID = "dsh";
var PERSISTENCE_VERSION = 1;
var MODE_PLAN = "plan";
var MODE_BUILD = "build";
var SETTING_PERMISSION = "permission-preset";
function readPersisted(persistence) {
  if (persistence === void 0) return void 0;
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return void 0;
  const record = data;
  const dshSessionId = record.dshSessionId;
  const cwd = record.cwd;
  if (typeof dshSessionId !== "string" || typeof cwd !== "string") return void 0;
  return {
    dshSessionId,
    cwd,
    ...typeof record.lastSeq === "number" ? { lastSeq: record.lastSeq } : {}
  };
}
function writePersisted(session) {
  return {
    version: PERSISTENCE_VERSION,
    data: { dshSessionId: session.dshSessionId, cwd: session.cwd, ...session.lastSeq !== void 0 ? { lastSeq: session.lastSeq } : {} }
  };
}
var PaseoSession = class {
  /** Paseo-side session id (the id Paseo minted). */
  id;
  /** Durable DSH session id. */
  dshSessionId;
  cwd;
  config;
  /** Active turn id, or null between turns. */
  activeTurnId = null;
  /** Monotonic turn counter for ids Paseo can correlate. */
  turnCount = 0;
  /** Last durable DSH sequence number observed, for reconnect recovery. */
  lastSeq = 0;
  /** Child sessions spawned by this session, keyed by DSH child id. */
  children = /* @__PURE__ */ new Map();
  /** Detach handlers registered for this session. */
  detachers = [];
  constructor(params) {
    this.id = params.id;
    this.dshSessionId = params.dshSessionId;
    this.cwd = params.cwd;
    this.config = params.config;
  }
  /** The persistence record Paseo should store for this session. */
  get persistence() {
    return writePersisted({ dshSessionId: this.dshSessionId, cwd: this.cwd, lastSeq: this.lastSeq });
  }
};
function createDshProvider(options = {}) {
  const startHostImpl = options.startHost ?? startHost;
  const probeDshImpl = options.probeDsh ?? probeDsh;
  const log = options.log ?? (() => void 0);
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness",
    description: "Drives a native DeepSeek Harness (dsh) host: plan mode, model and reasoning-effort switching, sandbox permissions, tool approvals, interactive questions, sub-agents and resumable native sessions.",
    icon: "icon.svg",
    /** Default executable; the daemon may override it through provider config. */
    command: ["dsh"],
    /**
     * Availability probe. Paseo calls this before showing the provider as
     * usable, so a missing CLI becomes an actionable diagnostic instead of a
     * failed first session.
     */
    async status(request) {
      const probe = await probeDshImpl(
        request.launch !== void 0 ? { launch: request.launch } : {},
        process.env
      );
      if (probe.available === false) return { available: false, diagnostic: probe.diagnostic };
      return probe.diagnostic !== void 0 ? { available: true, diagnostic: `dsh ${probe.diagnostic}` } : { available: true };
    },
    /**
     * Catalogue cache key: the effective launch plan and the profile. Two Paseo
     * workspaces that resolve to the same host share one discovery result.
     */
    async getCatalogCacheKey(request) {
      const cwd = request.scope === "workspace" ? request.cwd : "";
      const command = request.launch?.command ?? "dsh";
      return `${command}|${process.env.DSH_HOME ?? ""}|${process.env.DSH_PASEO_PROFILE ?? DEFAULT_PROFILE}|${cwd}`;
    },
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        throw new Error(
          `DeepSeek Harness provider requires Paseo provider protocol ${PROVIDER_PROTOCOL_VERSION}; the daemon offered ${request.versions.join(", ")}`
        );
      }
      const capabilities = negotiateProviderCapabilities(request.capabilities, [...PROVIDER_CAPABILITIES]);
      const lazy = createLazyConnection({
        capabilities,
        startHost: startHostImpl,
        ...options.requestTimeoutMs !== void 0 ? { requestTimeoutMs: options.requestTimeoutMs } : {},
        ...request.launch !== void 0 ? { launch: request.launch } : {},
        // The daemon resolves the provider's configured environment into the launch
        // it passes to connect(); carrying it here is what makes a custom DSH home,
        // profile or PATH reach the child process.
        ...request.launch?.env !== void 0 ? { env: request.launch.env } : {},
        log
      });
      return lazy;
    }
  };
}
async function openConnection(input) {
  const plan = planHost({
    ...input.launch !== void 0 ? { launch: input.launch } : {},
    env: input.env ?? {}
  }, process.env);
  input.log(`launching ${plan.command} ${plan.args.join(" ")}`);
  const channel = await input.startHost(plan, {
    onStderr: (line) => {
      if (line.includes("paseo-bridge") || line.startsWith("stdout:")) input.log(line);
    }
  });
  let closedReason;
  const client = new BridgeClient({
    socket: channel.socket,
    ...input.requestTimeoutMs !== void 0 ? { timeoutMs: input.requestTimeoutMs } : {},
    onClose: (reason) => {
      closedReason = reason;
    },
    onHandlerError: (method, error) => {
      input.log(`notification handler failed for ${method}: ${String(error)}`);
    }
  });
  let init;
  try {
    const params = {
      wireVersion: BRIDGE_WIRE_VERSION,
      client: { name: "paseo-provider-dsh", version: "0.1.0" },
      providerProtocol: PROVIDER_PROTOCOL_VERSION
    };
    init = await client.request("bridge/initialize", params, 3e4);
  } catch (error) {
    client.close("handshake failed");
    await channel.close();
    if (error instanceof BridgeRpcError && error.code === RPC_ERROR.unsupported) {
      throw new Error(
        `DeepSeek Harness bridge is incompatible: ${error.message}. Reinstall the bridge for this dsh version (see docs/INSTALL.md).`
      );
    }
    throw error;
  }
  if (closedReason !== void 0) {
    await channel.close();
    throw new Error(`DeepSeek Harness bridge closed during handshake: ${closedReason}`);
  }
  input.log(`bridge ready: dsh ${init.dshVersion}, bridge ${init.bridgeVersion}`);
  const state = {
    capabilities: input.capabilities,
    features: init.features,
    client,
    channel,
    sessions: /* @__PURE__ */ new Map(),
    dshVersion: init.dshVersion,
    closed: false
  };
  return { client, channel, state };
}
function createLazyConnection(input) {
  const listeners = /* @__PURE__ */ new Set();
  let starting;
  let live;
  let closed = false;
  const buffered = [];
  const emit = (event) => {
    if (closed) return;
    if (live === void 0) {
      buffered.push(event);
      if (buffered.length > 256) buffered.shift();
      return;
    }
    for (const listener of listeners) listener(event);
  };
  const ready = async () => {
    if (live !== void 0) return live;
    if (starting !== void 0) return starting;
    starting = (async () => {
      const opened = await openConnection({
        capabilities: input.capabilities,
        startHost: input.startHost,
        ...input.requestTimeoutMs !== void 0 ? { requestTimeoutMs: input.requestTimeoutMs } : {},
        ...input.launch !== void 0 ? { launch: input.launch } : {},
        ...input.env !== void 0 ? { env: input.env } : {},
        log: input.log
      });
      live = opened;
      const pending = buffered.splice(0);
      for (const event of pending) {
        for (const listener of listeners) listener(event);
      }
      return opened;
    })();
    try {
      return await starting;
    } finally {
      starting = void 0;
    }
  };
  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities: input.capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const current = live;
      if (current !== void 0) {
        for (const session of current.state.sessions.values()) {
          for (const detach of session.detachers) {
            try {
              detach();
            } catch {
            }
          }
        }
        current.state.sessions.clear();
        current.client.close("provider connection closed");
        await current.channel.close();
      }
      await starting?.catch(() => void 0);
      listeners.clear();
    },
    async send(message) {
      if (closed) throw new Error("DeepSeek Harness provider connection is closed");
      try {
        if (message.type === "session.close" && live === void 0) {
          emit({ type: "session.closed", sessionId: message.sessionId });
          emit({ type: "request.completed", requestId: message.requestId });
          return;
        }
        const opened = await ready();
        await dispatch(message, {
          client: opened.client,
          state: opened.state,
          emit,
          log: input.log
        });
      } catch (error) {
        failInput(message, emit, error);
      }
    }
  };
}
function failInput(input, emit, error) {
  const failure = describeError(error);
  if (input.type === "session.prompt") {
    emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: failure }
    });
    return;
  }
  if ("requestId" in input && input.requestId !== void 0) {
    emit({ type: "request.failed", requestId: input.requestId, error: failure });
    return;
  }
  if ("sessionId" in input) {
    emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
  }
}
function describeError(error) {
  if (error instanceof BridgeRpcError) {
    return {
      message: error.message,
      code: error.code === RPC_ERROR.domain ? "dsh/domain" : error.code === RPC_ERROR.unsupported ? "dsh/unsupported" : "dsh/bridge",
      ...typeof error.data === "string" ? { diagnostic: error.data } : {}
    };
  }
  if (error instanceof HostStartError) {
    return { message: error.message, code: "dsh/host-start", diagnostic: error.diagnostic.slice(0, 4e3) };
  }
  if (error instanceof Error) {
    return { message: error.message, ...error.stack !== void 0 ? { diagnostic: error.stack.slice(0, 2e3) } : {} };
  }
  return { message: String(error) };
}
async function dispatch(input, context) {
  const { client, state, emit } = context;
  switch (input.type) {
    case "catalog":
      await handleCatalog(input, context);
      return;
    case "sessions":
      await handleSessions(input, context);
      return;
    case "session.open":
      await handleOpen(input, context);
      return;
    case "session.prompt":
      await handlePrompt(input, context);
      return;
    case "session.interrupt": {
      const session = requireSession(state, input.sessionId);
      await client.request("session/cancel", { sessionId: session.dshSessionId });
      if (session.activeTurnId !== null) {
        const turnId = session.activeTurnId;
        session.activeTurnId = null;
        emit({ type: "session.turn", sessionId: session.id, turnId, state: "canceled" });
      }
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.permission": {
      const session = requireSession(state, input.sessionId);
      await answerPermission(input, session, context);
      return;
    }
    case "session.configure":
      await handleConfigure(input, context);
      return;
    case "session.revert": {
      const session = requireSession(state, input.sessionId);
      if (input.scope === "files") {
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "DeepSeek Harness has no file-level revert; use conversation revert instead", code: "dsh/unsupported" }
        });
        return;
      }
      const atSeq = typeof input.token === "object" && input.token !== null && typeof input.token.seq === "number" ? input.token.seq : void 0;
      const forked = await client.request("session/fork", {
        sessionId: session.dshSessionId,
        ...atSeq !== void 0 ? { atSeq } : {}
      });
      emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: `fork-${Date.now()}`,
          severity: "info",
          title: "Session forked",
          description: `DeepSeek Harness created ${forked.sessionId} at the requested point.`
        }
      });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: {
          message: `${input.type} is not supported by the DeepSeek Harness provider`,
          code: "dsh/unsupported"
        }
      });
      return;
    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      if (session !== void 0) {
        for (const detach of session.detachers) {
          try {
            detach();
          } catch {
          }
        }
        state.sessions.delete(input.sessionId);
        await client.request("session/release", { sessionId: session.dshSessionId }).catch(() => void 0);
      }
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
  }
}
function requireSession(state, sessionId) {
  const session = state.sessions.get(sessionId);
  if (session === void 0) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}
async function handleCatalog(input, context) {
  const { client, state, emit } = context;
  const models = await client.request("session/models", {}, 6e4);
  const catalog = catalogFrom(models);
  state.catalog = catalog;
  emit({ type: "catalog", requestId: input.requestId, catalog });
}
function isOfficialDeepseek(modelId) {
  return modelId.startsWith("deepseek-official/") || modelId.startsWith("deepseek-account/");
}
function catalogFrom(models) {
  const providerModels = [];
  for (const group of models.groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? [];
      const thinkingOptions = efforts.map((effort) => ({
        id: `${group.id}/${model.id}/${effort.id}`,
        label: effort.name,
        ...effort.description !== void 0 ? { description: effort.description } : {},
        ...models.default.reasoningEffort === effort.id && models.default.provider === group.id && models.default.model === model.id ? { isDefault: true } : {},
        metadata: { provider: group.id, model: model.id, effort: effort.id }
      }));
      providerModels.push({
        id: `${group.id}/${model.id}`,
        label: model.name,
        description: model.description ?? group.name,
        ...models.default.provider === group.id && models.default.model === model.id ? { isDefault: true } : {},
        metadata: { provider: group.id, model: model.id },
        ...thinkingOptions.length > 0 ? {
          thinkingOptions,
          ...model.reasoning?.defaultEffort !== void 0 ? { defaultThinkingOptionId: `${group.id}/${model.id}/${model.reasoning.defaultEffort}` } : {}
        } : {}
      });
    }
  }
  const modes = [
    {
      id: MODE_BUILD,
      label: "Build",
      description: "Implement changes directly."
    },
    {
      id: MODE_PLAN,
      label: "Plan",
      description: "DeepSeek Harness plan mode: explore and present a plan for approval."
    }
  ];
  const officialDefault = providerModels.find((model) => model.isDefault === true && isOfficialDeepseek(model.id)) ?? providerModels.find((model) => isOfficialDeepseek(model.id) && model.id.endsWith("/deepseek-flash")) ?? providerModels.find((model) => isOfficialDeepseek(model.id)) ?? providerModels.find((model) => model.isDefault === true) ?? providerModels[0];
  return {
    models: providerModels,
    modes,
    ...officialDefault !== void 0 ? { defaultModel: officialDefault.id } : {},
    defaultMode: MODE_BUILD
  };
}
async function handleSessions(input, context) {
  const { client, emit, log } = context;
  try {
    const list = await client.request("sessions/list", { ...input.limit !== void 0 ? { limit: input.limit } : {} });
    emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: list.items.filter((item) => item.origin !== "subagent").map((item) => ({
        persistence: writePersisted({ dshSessionId: item.sessionId, cwd: item.cwd ?? "" }),
        cwd: item.cwd ?? "",
        ...item.sessionId.length > 0 ? { title: `DeepSeek Harness ${item.sessionId.slice(-8)}` } : {},
        ...item.updatedAt > 0 ? { updatedAt: new Date(item.updatedAt).toISOString() } : {}
      }))
    });
  } catch (error) {
    log(`session listing failed: ${describeError(error).message}`);
    emit({ type: "sessions", requestId: input.requestId, sessions: [] });
  }
}
async function handleOpen(input, context) {
  const { client, state, emit, log } = context;
  if (state.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  const persisted = readPersisted(input.persistence);
  let dshSessionId;
  let cwd = input.config.cwd;
  let reused = false;
  if (persisted !== void 0) {
    const resumed = await client.request("session/resume", { sessionId: persisted.dshSessionId });
    dshSessionId = resumed.sessionId;
    cwd = resumed.cwd.length > 0 ? resumed.cwd : cwd;
    if (resumed.migrationRequired) {
      log(`session ${dshSessionId} was written by a newer harness; opening read-only`);
    }
  } else {
    const created = await client.request("session/create", {
      sessionId: newDshSessionIdFor(input.sessionId),
      cwd,
      ...input.config.title !== void 0 ? { title: input.config.title } : {}
    });
    dshSessionId = created.sessionId;
    cwd = created.cwd.length > 0 ? created.cwd : cwd;
    reused = created.reused;
  }
  const session = new PaseoSession({ id: input.sessionId, dshSessionId, cwd, config: input.config });
  state.sessions.set(input.sessionId, session);
  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence: session.persistence,
    ...input.config.title !== void 0 ? { title: input.config.title } : {},
    cwd
  });
  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  attachSessionRouting(session, context);
  if (input.history === "replay" && persisted !== void 0) {
    try {
      const page = await client.request("session/page", {
        sessionId: dshSessionId,
        throughSeq: persisted.lastSeq ?? Number.MAX_SAFE_INTEGER,
        maxMessages: 60
      });
      for (const event of page.records) {
        for (const item of timelineItemsFor(dshSessionId, event)) {
          emit({ type: "timeline.item", sessionId: session.id, item });
        }
        session.lastSeq = Math.max(session.lastSeq, event.seq);
      }
    } catch (error) {
      log(`history replay skipped: ${describeError(error).message}`);
    }
  }
  await applyInitialSelection(session, context, input.config);
  await publishConfig(session, context, "config");
  try {
    const commands = await client.request("session/commands", { sessionId: dshSessionId });
    emit({
      type: "session.commands",
      sessionId: session.id,
      commands: commands.commands.map((command) => ({
        name: command.name,
        description: command.description.length > 0 ? command.description : command.name
      }))
    });
  } catch (error) {
    log(`command listing unavailable: ${describeError(error).message}`);
  }
  if (reused) {
    emit({
      type: "session.notice",
      sessionId: session.id,
      notice: {
        id: `reused-${Date.now()}`,
        severity: "info",
        title: "Reused a blank DeepSeek Harness session"
      }
    });
  }
}
function newDshSessionIdFor(paseoSessionId) {
  const hex = Buffer.from(paseoSessionId).toString("hex").padEnd(32, "0").slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `session-${uuid}`;
}
function attachSessionRouting(session, context) {
  const { client, emit, log } = context;
  const dshId = session.dshSessionId;
  const offEvent = client.on("session/event", (params) => {
    if (params.sessionId === dshId) {
      onSessionEvent(session, params.event, context);
      return;
    }
    const child = findChildSession(context.state, params.sessionId);
    if (child !== void 0 && child.parentSessionId === dshId) {
      onChildEvent(child.paseoSessionId, params.event, context);
    }
  });
  const offStatus = client.on("session/status", (params) => {
    if (params.sessionId !== dshId) return;
    if (params.status === "running" && session.activeTurnId === null) {
      session.turnCount += 1;
      session.activeTurnId = `turn-${session.turnCount}`;
      emit({ type: "session.turn", sessionId: session.id, turnId: session.activeTurnId, state: "started" });
    }
  });
  const offStream = client.on("session/assistantStream", (params) => {
    if (params.sessionId !== dshId) return;
    onAssistantFrame(session, params.frame, emit);
  });
  const offPermission = client.on("permission/request", (params) => {
    if (params.sessionId !== dshId) return;
    const id = permissionId(dshId, params.requestId);
    const args = params.input ?? {};
    emit({
      type: "session.permission",
      sessionId: session.id,
      request: {
        id,
        name: params.toolName,
        kind: "tool",
        title: `Allow ${params.toolName}?`,
        ...params.reason !== void 0 ? { description: params.reason } : params.displayReason !== void 0 ? { description: params.displayReason.en ?? Object.values(params.displayReason)[0] ?? "" } : {},
        ...params.input !== void 0 ? { input: args } : {},
        detail: toolDetail(params.toolName, args),
        actions: [
          { id: "allow-once", label: "Allow once", behavior: "allow", variant: "primary" },
          { id: "reject-once", label: "Reject", behavior: "deny", variant: "danger" }
        ],
        metadata: { dshRequestId: params.requestId, sessionId: dshId }
      }
    });
  });
  const offPermissionResolved = client.on("permission/resolved", (params) => {
    if (params.sessionId !== dshId) return;
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionId(dshId, params.requestId) });
  });
  const offQuestion = client.on("questions/request", (params) => {
    if (params.sessionId !== dshId) return;
    emit({
      type: "session.permission",
      sessionId: session.id,
      request: {
        id: questionId(dshId, params.requestId),
        name: "ask_user_question",
        kind: "question",
        title: params.questions[0]?.header ?? params.questions[0]?.question ?? "DeepSeek Harness question",
        description: params.questions.map((question) => question.question).join("\n\n"),
        actions: params.questions.flatMap((question) => question.options ?? []).map((option, index) => ({
          id: `option-${index}`,
          label: option.label,
          behavior: "allow",
          variant: "secondary"
        })),
        metadata: {
          dshRequestId: params.requestId,
          sessionId: dshId,
          questions: params.questions
        }
      }
    });
  });
  const offQuestionResolved = client.on("questions/resolved", (params) => {
    if (params.sessionId !== dshId) return;
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: questionId(dshId, params.requestId) });
  });
  const offSubStart = client.on("subagent/started", (params) => {
    if (params.parentSessionId !== dshId) return;
    openChildSession(session, params, context);
  });
  const offSubEnd = client.on("subagent/finished", (params) => {
    if (params.parentSessionId !== dshId) return;
    const child = findChildSession(context.state, params.childSessionId);
    if (child === void 0) return;
    emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "tool_call",
        id: child.toolCallId !== void 0 ? toolItemId(dshId, child.toolCallId) : `dsh:${dshId}:sub:${params.childSessionId}`,
        callId: child.toolCallId ?? params.childSessionId,
        name: "subagent",
        detail: {
          type: "sub_agent",
          ...child.label !== void 0 ? { description: child.label } : {},
          childSessionId: params.childSessionId,
          log: params.lastAssistantText ?? ""
        },
        ...params.status === "ok" ? { status: "completed", error: null } : { status: "failed", error: { message: params.stopReason } }
      }
    });
  });
  const offConfig = client.on("session/configChanged", (params) => {
    if (params.sessionId !== dshId) return;
    if (params.models.selected !== void 0) {
      applySelectionToConfig(session, params.models);
    }
  });
  const offPlan = client.on("session/planChanged", (params) => {
    if (params.sessionId !== dshId) return;
    session.config = { ...session.config, mode: params.active ? MODE_PLAN : MODE_BUILD };
    void publishConfig(session, context, "plan");
  });
  const offPermissionChanged = client.on("session/permissionChanged", (params) => {
    if (params.sessionId !== dshId) return;
    session.config = {
      ...session.config,
      settings: { ...session.config.settings, [SETTING_PERMISSION]: params.permission.current }
    };
    void publishConfig(session, context, "permission");
  });
  session.detachers.push(
    offEvent,
    offStatus,
    offStream,
    offPermission,
    offPermissionResolved,
    offQuestion,
    offQuestionResolved,
    offSubStart,
    offSubEnd,
    offConfig,
    offPlan,
    offPermissionChanged
  );
  log(`session ${session.id} routed to ${dshId}`);
}
function findChildSession(state, childDshId) {
  for (const session of state.sessions.values()) {
    for (const [childId, meta] of session.children) {
      if (childId === childDshId) {
        return { paseoSessionId: childId, parentSessionId: session.dshSessionId, ...meta };
      }
    }
  }
  return void 0;
}
function onChildEvent(paseoChildId, event, context) {
  for (const item of timelineItemsFor(paseoChildId, event)) {
    context.emit({ type: "timeline.item", sessionId: paseoChildId, item });
  }
}
function openChildSession(parent, params, context) {
  const { emit } = context;
  if (parent.children.has(params.childSessionId)) return;
  parent.children.set(params.childSessionId, {
    ...params.toolCallId !== void 0 ? { toolCallId: params.toolCallId } : {},
    ...params.label !== void 0 ? { label: params.label } : {}
  });
  const paseoChildId = `sub:${params.childSessionId}`;
  context.state.sessions.set(paseoChildId, parent);
  emit({
    type: "session.opened",
    sessionId: paseoChildId,
    parentSessionId: parent.id,
    ...params.toolCallId !== void 0 ? { toolCallId: params.toolCallId } : {},
    capabilities: [],
    restoration: "parent",
    ...params.label !== void 0 ? { title: params.label } : {},
    cwd: parent.cwd
  });
  emit({ type: "session.ready", sessionId: paseoChildId });
  if (params.toolCallId !== void 0) {
    emit({
      type: "timeline.item",
      sessionId: parent.id,
      item: {
        type: "tool_call",
        id: toolItemId(parent.dshSessionId, params.toolCallId),
        callId: params.toolCallId,
        name: "subagent",
        detail: {
          type: "sub_agent",
          ...params.label !== void 0 ? { description: params.label } : {},
          ...params.provider !== void 0 ? { subAgentType: params.provider } : {},
          childSessionId: params.childSessionId,
          log: ""
        },
        status: "running",
        error: null
      }
    });
  }
}
function onSessionEvent(session, event, context) {
  const { emit } = context;
  session.lastSeq = Math.max(session.lastSeq, event.seq);
  if (event.type === "turn/start") {
    if (session.activeTurnId === null) {
      session.turnCount += 1;
      session.activeTurnId = `turn-${session.turnCount}`;
      emit({ type: "session.turn", sessionId: session.id, turnId: session.activeTurnId, state: "started" });
    }
    return;
  }
  if (event.type === "turn/end") {
    const reason = event.data.reason;
    const turnId = session.activeTurnId ?? `turn-${session.turnCount}`;
    session.activeTurnId = null;
    const failed = reason === "error";
    const canceled = reason === "canceled" || reason === "cancelled" || reason === "aborted";
    emit({
      type: "session.turn",
      sessionId: session.id,
      turnId,
      state: failed ? "failed" : canceled ? "canceled" : "completed",
      ...failed ? { error: { message: typeof event.data.message === "string" ? event.data.message : "turn failed" } } : {}
    });
    emit({ type: "session.persistence", sessionId: session.id, persistence: session.persistence });
    return;
  }
  if (event.type === "model/selection") {
    const provider = event.data.provider;
    const model = event.data.model;
    if (typeof provider === "string" && typeof model === "string") {
      const effort = event.data.reasoningEffort;
      session.config = {
        ...session.config,
        model: `${provider}/${model}`,
        ...typeof effort === "string" ? { thinkingOption: `${provider}/${model}/${effort}` } : {}
      };
    }
    return;
  }
  if (event.type === "plan/mode") {
    const active = event.data.active === true;
    session.config = { ...session.config, mode: active ? MODE_PLAN : MODE_BUILD };
    void publishConfig(session, context, "plan-mode-event");
    return;
  }
  if (event.type === "permission/preset") {
    const preset = event.data.preset;
    if (typeof preset === "string") {
      session.config = { ...session.config, settings: { ...session.config.settings, [SETTING_PERMISSION]: preset } };
    }
    return;
  }
  for (const item of timelineItemsFor(session.dshSessionId, event)) {
    emit({ type: "timeline.item", sessionId: session.id, item });
  }
}
function onAssistantFrame(session, frame, emit) {
  if (frame.type !== "chunk") return;
  const chunk = frame.chunk;
  if (typeof chunk !== "object" || chunk === null) return;
  const body = chunk;
  const type = typeof body.type === "string" ? body.type : "";
  const text = typeof body.text === "string" ? body.text : typeof body.delta === "string" ? body.delta : typeof body.content === "string" ? body.content : void 0;
  if (text === void 0 || text.length === 0) return;
  if (type === "text-delta" || type === "text") {
    emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "assistant_message",
        id: `dsh:${session.dshSessionId}:assistant:${frame.attemptId}`,
        text,
        messageId: frame.attemptId
      }
    });
    return;
  }
  if (type === "reasoning-delta" || type === "thinking-delta") {
    emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "reasoning",
        id: `dsh:${session.dshSessionId}:reasoning:${frame.attemptId}`,
        text
      }
    });
  }
}
async function publishConfig(session, context, reason) {
  const { client, emit, log } = context;
  try {
    const [models, permission] = await Promise.all([
      client.request("session/models", { sessionId: session.dshSessionId }, 6e4),
      client.request("session/permission", { sessionId: session.dshSessionId }).catch(() => void 0)
    ]);
    const providerModels = catalogFrom(models).models;
    if (models.selected !== void 0 && session.config.model === void 0) {
      applySelectionToConfig(session, models);
    }
    const config = {
      ...session.config.model !== void 0 ? { model: session.config.model } : {},
      ...session.config.mode !== void 0 ? { mode: session.config.mode } : {},
      ...session.config.thinkingOption !== void 0 ? { thinkingOption: session.config.thinkingOption } : {},
      models: providerModels,
      modes: catalogFrom(models).modes,
      thinkingOptions: providerModels.flatMap((model) => model.thinkingOptions ?? []),
      settings: permissionSettings(permission)
    };
    emit({ type: "session.config", sessionId: session.id, config });
  } catch (error) {
    log(`config publication failed (${reason}): ${describeError(error).message}`);
  }
}
function permissionSettings(permission) {
  if (permission === void 0 || permission.options.length === 0) return [];
  return [
    {
      type: "select",
      id: SETTING_PERMISSION,
      label: "Permissions",
      description: "DeepSeek Harness sandbox and approval preset.",
      value: permission.current,
      options: permission.options.map((option) => ({ label: option.label, value: option.name }))
    }
  ];
}
function applySelectionToConfig(session, models) {
  const selected = models.selected;
  if (selected === void 0) return;
  session.config = {
    ...session.config,
    model: `${selected.provider}/${selected.model}`,
    ...selected.reasoningEffort !== void 0 ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` } : {}
  };
}
async function handlePrompt(input, context) {
  const { client, emit, log } = context;
  const session = requireSession(context.state, input.sessionId);
  const { prompt } = input;
  if (prompt.delivery === "steer") {
    if (session.activeTurnId === null) {
      emit({
        type: "session.prompt_result",
        sessionId: session.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "There is no active turn to steer" } }
      });
      return;
    }
    await admitPrompt(session, input, "steer", context);
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "steer", turnId: session.activeTurnId }
    });
    return;
  }
  if (prompt.input.type === "command") {
    const name = prompt.input.name;
    const args = prompt.input.arguments;
    if (name === "plan") {
      try {
        const active = args.trim() !== "off";
        const result = await client.request("session/setPlanMode", { sessionId: session.dshSessionId, active });
        session.config = { ...session.config, mode: result.active ? MODE_PLAN : MODE_BUILD };
        await publishConfig(session, context, "command-plan");
        emit({
          type: "session.notice",
          sessionId: session.id,
          notice: {
            id: `plan-${Date.now()}`,
            severity: "info",
            title: result.active ? "Plan mode on" : "Plan mode off"
          }
        });
        emit({
          type: "session.prompt_result",
          sessionId: session.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "completed" }
        });
      } catch (error) {
        emit({
          type: "session.prompt_result",
          sessionId: session.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: describeError(error) }
        });
      }
      return;
    }
    const text = `/${name}${args.length > 0 ? ` ${args}` : ""}`;
    await admitPrompt(session, { ...input, prompt: { ...prompt, input: { type: "message", content: [{ type: "text", text }] } } }, "queue", context);
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "completed" }
    });
    return;
  }
  if (prompt.input.type !== "message") {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: { message: "Unsupported prompt input" } }
    });
    return;
  }
  const content = prompt.input.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return { type: "image", mediaType: part.mimeType, data: part.data };
    }
    const body = part.text;
    if (typeof body === "string" && body.length > 0) {
      return { type: "text", text: body };
    }
    return void 0;
  }).filter((part) => part !== void 0);
  if (content.length === 0) {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: { message: "Prompt carried no content DeepSeek Harness can accept" } }
    });
    return;
  }
  await ensureModelSelected(session, context);
  try {
    await client.request("session/prompt", {
      sessionId: session.dshSessionId,
      requestId: prompt.clientMessageId,
      mode: "queue",
      content
    });
  } catch (error) {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: describeError(error) }
    });
    return;
  }
  session.turnCount += 1;
  session.activeTurnId = `turn-${session.turnCount}`;
  const turnId = session.activeTurnId;
  emit({
    type: "session.prompt_result",
    sessionId: session.id,
    clientMessageId: prompt.clientMessageId,
    result: { type: "turn", turnId }
  });
  emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
  log(`turn ${turnId} admitted on ${session.dshSessionId}`);
}
async function admitPrompt(session, input, mode, context) {
  const { prompt } = input;
  if (prompt.input.type !== "message") return;
  const content = prompt.input.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image", mediaType: part.mimeType, data: part.data };
    if ("text" in part && typeof part.text === "string") return { type: "text", text: part.text };
    return void 0;
  }).filter((part) => part !== void 0);
  await context.client.request("session/prompt", {
    sessionId: session.dshSessionId,
    requestId: prompt.clientMessageId,
    mode,
    content
  });
}
async function ensureModelSelected(session, context) {
  if (session.config.model !== void 0) return;
  const models = await context.client.request("session/models", { sessionId: session.dshSessionId }, 6e4);
  if (models.selected !== void 0) {
    applySelectionToConfig(session, models);
    return;
  }
  const selected = await context.client.request("session/selectModel", {
    sessionId: session.dshSessionId,
    provider: models.default.provider,
    model: models.default.model,
    ...models.default.reasoningEffort !== void 0 ? { reasoningEffort: models.default.reasoningEffort } : {}
  });
  session.config = {
    ...session.config,
    model: `${selected.provider}/${selected.model}`,
    ...selected.reasoningEffort !== void 0 ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` } : {}
  };
  context.log(`selected default model ${session.config.model}`);
}
async function answerPermission(input, session, context) {
  const { client, emit } = context;
  const permissionIdValue = input.permissionId;
  const isQuestion = permissionIdValue.includes(":question:");
  if (isQuestion) {
    const answers = input.response.behavior === "allow" && input.response.updatedInput !== void 0 ? readQuestionAnswersFromInput(input.response.updatedInput) : [];
    await client.request("questions/answer", {
      requestId: extractBridgeId(permissionIdValue),
      answers
    });
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionIdValue });
    return;
  }
  const outcome = input.response.behavior === "allow" ? "allowed-once" : input.response.interrupt === true ? "cancelled" : "rejected";
  await client.request("permission/answer", {
    requestId: extractBridgeId(permissionIdValue),
    outcome
  });
  emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionIdValue });
}
function extractBridgeId(paseoPermissionId) {
  const parts = paseoPermissionId.split(":");
  return parts[parts.length - 1] ?? paseoPermissionId;
}
function readQuestionAnswersFromInput(input) {
  const answers = input.answers;
  if (!Array.isArray(answers)) {
    const selected = input.selected;
    if (Array.isArray(selected)) {
      return [{ selected: selected.filter((item) => typeof item === "string") }];
    }
    return [];
  }
  return answers.map((answer) => {
    if (typeof answer !== "object" || answer === null) return void 0;
    const record = answer;
    const selected = Array.isArray(record.selected) ? record.selected.filter((item) => typeof item === "string") : [];
    return { selected, ...typeof record.text === "string" ? { text: record.text } : {} };
  }).filter((answer) => answer !== void 0);
}
async function handleConfigure(input, context) {
  const { client, emit, log } = context;
  const session = requireSession(context.state, input.sessionId);
  const changes = input.changes;
  const liveModels = await client.request("session/models", { sessionId: session.dshSessionId }, 6e4).catch(() => void 0);
  const catalogue = {
    modelIds: (liveModels?.groups ?? []).flatMap(
      (group) => group.models.map((model) => `${group.id}/${model.id}`)
    ),
    providers: (liveModels?.groups ?? []).map((group) => group.id),
    effortsOf: (modelId) => {
      const slash = modelId.indexOf("/");
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      const group = (liveModels?.groups ?? []).find((candidate) => candidate.id === provider);
      const found = group?.models.find((candidate) => candidate.id === model);
      return (found?.reasoning?.efforts ?? []).map((effort) => effort.id);
    }
  };
  if (changes.model !== void 0 && changes.model !== null) {
    const parsed = splitModelId(changes.model, catalogue);
    if (parsed === void 0) {
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Unrecognized model id: ${changes.model}`, code: "dsh/invalid-model" }
      });
      return;
    }
    const effort = changes.thinkingOption !== void 0 ? changes.thinkingOption === null ? void 0 : splitModelId(changes.thinkingOption, catalogue)?.effort : splitModelId(session.config.thinkingOption ?? "", catalogue)?.effort;
    try {
      const selected = await client.request("session/selectModel", {
        sessionId: session.dshSessionId,
        provider: parsed.provider,
        model: parsed.model,
        ...effort !== void 0 ? { reasoningEffort: effort } : {}
      });
      session.config = {
        ...session.config,
        model: `${selected.provider}/${selected.model}`,
        ...selected.reasoningEffort !== void 0 ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` } : { thinkingOption: void 0 }
      };
    } catch (error) {
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: describeError(error)
      });
      return;
    }
  } else if (changes.thinkingOption !== void 0) {
    const current = splitModelId(session.config.model ?? "", catalogue);
    const effort = changes.thinkingOption === null ? void 0 : splitModelId(changes.thinkingOption, catalogue)?.effort;
    if (current !== void 0) {
      try {
        const selected = await client.request("session/selectModel", {
          sessionId: session.dshSessionId,
          provider: current.provider,
          model: current.model,
          ...effort !== void 0 ? { reasoningEffort: effort } : {}
        });
        session.config = {
          ...session.config,
          model: `${selected.provider}/${selected.model}`,
          ...selected.reasoningEffort !== void 0 ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` } : { thinkingOption: void 0 }
        };
      } catch (error) {
        emit({ type: "request.failed", requestId: input.requestId, error: describeError(error) });
        return;
      }
    }
  }
  if (changes.mode !== void 0 && changes.mode !== null) {
    const active = changes.mode === MODE_PLAN;
    try {
      const result = await client.request("session/setPlanMode", { sessionId: session.dshSessionId, active });
      session.config = { ...session.config, mode: result.active ? MODE_PLAN : MODE_BUILD };
    } catch (error) {
      emit({ type: "request.failed", requestId: input.requestId, error: describeError(error) });
      return;
    }
  }
  if (changes.settings !== void 0) {
    const preset = changes.settings[SETTING_PERMISSION];
    if (typeof preset === "string") {
      try {
        const applied = await client.request("session/setPermission", {
          sessionId: session.dshSessionId,
          name: preset
        });
        session.config = {
          ...session.config,
          settings: { ...session.config.settings, [SETTING_PERMISSION]: applied.applied }
        };
      } catch (error) {
        log(`permission preset change failed: ${describeError(error).message}`);
        emit({ type: "request.failed", requestId: input.requestId, error: describeError(error) });
        return;
      }
    }
  }
  await publishConfig(session, context, "configure");
  emit({ type: "request.completed", requestId: input.requestId });
}
async function applyInitialSelection(session, context, config) {
  const { client, emit, log } = context;
  if (typeof config.model === "string" && config.model.length > 0) {
    const catalogue = await readCatalogue(client, session.dshSessionId).catch(() => void 0);
    const resolved = splitModelId(
      config.model,
      catalogue === void 0 ? void 0 : {
        modelIds: catalogue.modelIds,
        providers: catalogue.providers,
        effortsOf: catalogue.effortsOf
      }
    );
    const effort = (typeof config.thinkingOption === "string" && config.thinkingOption.length > 0 ? splitModelId(
      config.thinkingOption,
      catalogue === void 0 ? void 0 : {
        modelIds: catalogue.modelIds,
        providers: catalogue.providers,
        effortsOf: catalogue.effortsOf
      }
    )?.effort : void 0) ?? resolved?.effort;
    if (resolved === void 0) {
      log(`session.open carried an unusable model id: ${config.model}`);
      emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: `model-unparsed-${Date.now()}`,
          severity: "warning",
          title: "DeepSeek Harness did not apply the selected model",
          description: `Unrecognized model id "${config.model}". The harness is using its configured default.`
        }
      });
    } else {
      try {
        const selected = await client.request("session/selectModel", {
          sessionId: session.dshSessionId,
          provider: resolved.provider,
          model: resolved.model,
          ...effort !== void 0 ? { reasoningEffort: effort } : {}
        });
        session.config = {
          ...session.config,
          model: `${selected.provider}/${selected.model}`,
          ...selected.reasoningEffort !== void 0 ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` } : {}
        };
        log(`applied model ${selected.provider}/${selected.model}${effort !== void 0 ? ` @${effort}` : ""}`);
      } catch (error) {
        const described = describeError(error);
        log(`selectModel failed: ${described.message}`);
        emit({
          type: "session.notice",
          sessionId: session.id,
          notice: {
            id: `model-not-applied-${Date.now()}`,
            severity: "warning",
            title: "DeepSeek Harness rejected the selected model or effort",
            description: described.message
          }
        });
        try {
          const selected = await client.request("session/selectModel", {
            sessionId: session.dshSessionId,
            provider: resolved.provider,
            model: resolved.model
          });
          session.config = { ...session.config, model: `${selected.provider}/${selected.model}` };
        } catch {
        }
      }
    }
  }
  if (typeof config.mode === "string" && config.mode.length > 0) {
    const wantsPlan = config.mode === MODE_PLAN;
    try {
      const result = await client.request("session/setPlanMode", {
        sessionId: session.dshSessionId,
        active: wantsPlan
      });
      session.config = { ...session.config, mode: result.active ? MODE_PLAN : MODE_BUILD };
    } catch (error) {
      log(`initial plan mode switch failed: ${describeError(error).message}`);
    }
  }
  const preset = config.settings[SETTING_PERMISSION];
  if (typeof preset === "string" && preset.length > 0) {
    try {
      const applied = await client.request("session/setPermission", {
        sessionId: session.dshSessionId,
        name: preset
      });
      session.config = {
        ...session.config,
        settings: { ...session.config.settings, [SETTING_PERMISSION]: applied.applied }
      };
    } catch (error) {
      log(`initial permission preset failed: ${describeError(error).message}`);
    }
  }
}
async function readCatalogue(client, sessionId) {
  const models = await client.request(
    "session/models",
    sessionId !== void 0 ? { sessionId } : {},
    6e4
  );
  return {
    modelIds: models.groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`)),
    providers: models.groups.map((group) => group.id),
    effortsOf: (modelId) => {
      const slash = modelId.indexOf("/");
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      const group = models.groups.find((candidate) => candidate.id === provider);
      const found = group?.models.find((candidate) => candidate.id === model);
      return (found?.reasoning?.efforts ?? []).map((effort) => effort.id);
    }
  };
}
function splitModelId(value, catalogue) {
  if (value.length === 0) return void 0;
  const trimmed = value.startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;
  const modelIds = catalogue?.modelIds ?? [];
  for (const modelId of modelIds) {
    if (trimmed === modelId) {
      const cut = modelId.indexOf("/");
      return { provider: modelId.slice(0, cut), model: modelId.slice(cut + 1) };
    }
    if (trimmed.startsWith(`${modelId}/`)) {
      const effort = trimmed.slice(modelId.length + 1);
      const cut = modelId.indexOf("/");
      return { provider: modelId.slice(0, cut), model: modelId.slice(cut + 1), effort };
    }
  }
  const providers = [...catalogue?.providers ?? []].sort((left, right) => right.length - left.length);
  for (const provider of providers) {
    if (!trimmed.startsWith(`${provider}/`)) continue;
    const rest = trimmed.slice(provider.length + 1);
    if (rest.length === 0) continue;
    const efforts = catalogue?.effortsOf?.(`${provider}/${rest}`) ?? [];
    const slash2 = rest.lastIndexOf("/");
    if (slash2 > 0) {
      const tail = rest.slice(slash2 + 1);
      if (efforts.includes(tail)) {
        return { provider, model: rest.slice(0, slash2), effort: tail };
      }
    }
    return { provider, model: rest };
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return void 0;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}
export {
  catalogFrom,
  createDshProvider,
  isOfficialDeepseek,
  readCatalogue,
  splitModelId
};
//# sourceMappingURL=provider.mjs.map
