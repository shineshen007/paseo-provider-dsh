/**
 * The native Paseo provider for DeepSeek Harness.
 *
 * This is the Paseo half. It registers a first-class provider through
 * `@getpaseo/plugin/server/provider` — no ACP, no `runAcpProvider`, no protocol
 * translation layer — and drives a real `dsh` process through the private bridge
 * channel implemented in `dsh-bridge/`.
 *
 * Division of responsibility:
 *
 * - `server/host.ts` owns the `dsh` child process and its socket.
 * - `server/rpc-client.ts` owns the JSON-RPC channel.
 * - `server/session.ts` owns one Paseo session: its DSH session id, turn
 *   bookkeeping, capabilities and event routing.
 * - `shared/mapping.ts` owns the DSH->Paseo translation (pure functions).
 *
 * Everything in this file is glue plus the provider contract itself.
 *
 * Identity rule: Paseo mints the Paseo-side `sessionId`, and DSH owns the
 * durable one. The mapping is kept in `ProviderPersistence.data.dshSessionId`, so
 * a Paseo restart restores the exact DSH session instead of forking history.
 */

import type {
  ProviderCatalog,
  ProviderConfigState,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderMode,
  ProviderModel,
  ProviderPersistence,
  ProviderRegistration,
  ProviderSessionConfig,
  ProviderSetting,
  ProviderThinkingOption,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { negotiateProviderCapabilities, PROVIDER_PROTOCOL_VERSION } from "@getpaseo/plugin/server/provider";
import { BridgeClient, BridgeRpcError, RPC_ERROR } from "./rpc-client.ts";
import {
  DEFAULT_PROFILE,
  HostStartError,
  planHost,
  probeDsh,
  startHost,
  type BridgeChannel,
  type LaunchOverride,
} from "./host.ts";
import type {
  AssistantStreamFrame,
  BridgeFeatures,
  BridgeInitializeParams,
  BridgeInitializeResult,
  SessionModelsResult,
  SessionPermissionResult,
  SessionWireEvent,
} from "../shared/wire.ts";
import { BRIDGE_WIRE_VERSION } from "../shared/wire.ts";
import { timelineItemsFor, toolDetail, parseArguments, toolResultOf } from "./mapping.ts";
import { permissionId, questionId, toolItemId } from "./ids.ts";

/** Capabilities this provider implements, each backed by a bridge feature. */
const PROVIDER_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "permission",
  "timeline.plugin",
] as const;

/** Provider identifier, stable across releases. */
const PROVIDER_ID = "dsh";

/** Persistence schema version written into `ProviderPersistence.data`. */
const PERSISTENCE_VERSION = 1;

/** Paseo mode ids that correspond to real DSH state. */
const MODE_PLAN = "plan";
const MODE_BUILD = "build";

/** Settings ids exposed in the Paseo config UI. */
const SETTING_PERMISSION = "permission-preset";

/** The durable half of a session's persistence record. */
interface PersistedSession {
  readonly dshSessionId: string;
  readonly cwd: string;
  readonly lastSeq?: number;
}

/** Read the persisted DSH session identity from a Paseo persistence record. */
function readPersisted(persistence: ProviderPersistence | undefined): PersistedSession | undefined {
  if (persistence === undefined) return undefined;
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const dshSessionId = record.dshSessionId;
  const cwd = record.cwd;
  if (typeof dshSessionId !== "string" || typeof cwd !== "string") return undefined;
  return {
    dshSessionId,
    cwd,
    ...(typeof record.lastSeq === "number" ? { lastSeq: record.lastSeq } : {}),
  };
}

/** Write the durable half of a session's persistence record. */
function writePersisted(session: PersistedSession): ProviderPersistence {
  return {
    version: PERSISTENCE_VERSION,
    data: { dshSessionId: session.dshSessionId, cwd: session.cwd, ...(session.lastSeq !== undefined ? { lastSeq: session.lastSeq } : {}) },
  };
}

/**
 * One live Paseo session backed by a DSH session.
 *
 * Holds only state Paseo cannot derive: the DSH identity, the turn in flight and
 * the coalescing buffers for assistant deltas (Paseo appends text per
 * `messageId`, so deltas are forwarded as they arrive and never re-sent).
 */
class PaseoSession {
  /** Paseo-side session id (the id Paseo minted). */
  readonly id: string;
  /** Durable DSH session id. */
  dshSessionId: string;
  cwd: string;
  config: ProviderSessionConfig;
  /** Active turn id, or null between turns. */
  activeTurnId: string | null = null;
  /** Monotonic turn counter for ids Paseo can correlate. */
  turnCount = 0;
  /** Last durable DSH sequence number observed, for reconnect recovery. */
  lastSeq = 0;
  /** Child sessions spawned by this session, keyed by DSH child id. */
  readonly children = new Map<string, { toolCallId?: string; label?: string }>();
  /** Detach handlers registered for this session. */
  readonly detachers: Array<() => void> = [];

  constructor(params: {
    id: string;
    dshSessionId: string;
    cwd: string;
    config: ProviderSessionConfig;
  }) {
    this.id = params.id;
    this.dshSessionId = params.dshSessionId;
    this.cwd = params.cwd;
    this.config = params.config;
  }

  /** The persistence record Paseo should store for this session. */
  get persistence(): ProviderPersistence {
    return writePersisted({ dshSessionId: this.dshSessionId, cwd: this.cwd, lastSeq: this.lastSeq });
  }
}

/** Provider-level state shared across sessions on one connection. */
interface ConnectionState {
  readonly capabilities: readonly string[];
  readonly features: BridgeFeatures;
  readonly client: BridgeClient;
  readonly channel: BridgeChannel;
  readonly sessions: Map<string, PaseoSession>;
  /** Latest catalogue, refreshed on demand and on adapter changes. */
  catalog?: ProviderCatalog;
  /** DSH version reported by the bridge handshake. */
  readonly dshVersion: string;
  closed: boolean;
}

/** Options accepted by the provider factory, all optional for testability. */
export interface DshProviderOptions {
  /** Override the host launcher (used by tests with a fake bridge). */
  readonly startHost?: typeof startHost;
  /** Override the DSH binary probe. */
  readonly probeDsh?: typeof probeDsh;
  /** Per-request timeout for bridge calls. */
  readonly requestTimeoutMs?: number;
  /** Diagnostics sink; defaults to no-op so the daemon log stays clean. */
  readonly log?: (message: string) => void;
}

/**
 * Create the DeepSeek Harness provider registration.
 *
 * @param options - test seams and tuning knobs.
 * @returns the registration Paseo consumes.
 */
export function createDshProvider(options: DshProviderOptions = {}): ProviderRegistration {
  const startHostImpl = options.startHost ?? startHost;
  const probeDshImpl = options.probeDsh ?? probeDsh;
  const log = options.log ?? (() => undefined);

  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness",
    description:
      "Drives a native DeepSeek Harness (dsh) host: plan mode, model and reasoning-effort switching, sandbox permissions, tool approvals, interactive questions, sub-agents and resumable native sessions.",
    icon: "icon.svg",
    /** Default executable; the daemon may override it through provider config. */
    command: ["dsh"],
    /**
     * Availability probe. Paseo calls this before showing the provider as
     * usable, so a missing CLI becomes an actionable diagnostic instead of a
     * failed first session.
     */
    async status(request: { launch?: LaunchOverride }) {
      const probe = await probeDshImpl(
        request.launch !== undefined ? { launch: request.launch } : {},
        process.env,
      );
      if (probe.available === false) return { available: false, diagnostic: probe.diagnostic };
      return probe.diagnostic !== undefined
        ? { available: true, diagnostic: `dsh ${probe.diagnostic}` }
        : { available: true };
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
          `DeepSeek Harness provider requires Paseo provider protocol ${PROVIDER_PROTOCOL_VERSION}; the daemon offered ${request.versions.join(", ")}`,
        );
      }
      // The daemon gives `connect()` a bounded window, and a cold DSH boot can
      // exceed it. The host is therefore started lazily by the first input that
      // needs it (`catalog`, `session.open`, `sessions`), so connecting is cheap
      // and a slow boot reports its own timeout instead of failing the provider.
      const capabilities = negotiateProviderCapabilities(request.capabilities, [...PROVIDER_CAPABILITIES]);
      // Start the host lazily. The daemon gives `connect()` a bounded window and a
      // cold DSH boot can exceed it, so connecting only records the plan; the first
      // input that needs the host (`catalog`, `sessions`, `session.open`) starts it
      // and reports its own failure against that input.
      const lazy = createLazyConnection({
        capabilities,
        startHost: startHostImpl,
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(request.launch !== undefined ? { launch: request.launch } : {}),
        // The daemon resolves the provider's configured environment into the launch
        // it passes to connect(); carrying it here is what makes a custom DSH home,
        // profile or PATH reach the child process.
        ...(request.launch?.env !== undefined ? { env: request.launch.env } : {}),
        log,
      });
      return lazy;
    },
  };
}


/** Open the host and complete the handshake. */
async function openConnection(input: {
  launch?: LaunchOverride;
  capabilities: readonly string[];
  startHost: typeof startHost;
  requestTimeoutMs?: number;
  /** Per-connection environment, normally Paseo's `agents.providers.dsh.env`. */
  env?: Readonly<Record<string, string>>;
  log(message: string): void;
}): Promise<{ client: BridgeClient; channel: BridgeChannel; state: ConnectionState }> {
  // The daemon resolves `agents.providers.dsh.env` into the launch environment, and
  // an explicit session env may add to it. Both are honoured so a user can point the
  // provider at a non-default DSH home or profile without touching this plugin.
  const plan = planHost({
    ...(input.launch !== undefined ? { launch: input.launch } : {}),
    env: input.env ?? {},
  }, process.env);
  input.log(`launching ${plan.command} ${plan.args.join(" ")}`);

  const channel = await input.startHost(plan, {
    onStderr: (line) => {
      if (line.includes("paseo-bridge") || line.startsWith("stdout:")) input.log(line);
    },
  });

  let closedReason: string | undefined;
  const client = new BridgeClient({
    socket: channel.socket,
    ...(input.requestTimeoutMs !== undefined ? { timeoutMs: input.requestTimeoutMs } : {}),
    onClose: (reason) => {
      closedReason = reason;
    },
    onHandlerError: (method, error) => {
      input.log(`notification handler failed for ${method}: ${String(error)}`);
    },
  });

  // Handshake: version and feature negotiation happens before any session work.
  let init: BridgeInitializeResult;
  try {
    const params: BridgeInitializeParams = {
      wireVersion: BRIDGE_WIRE_VERSION,
      client: { name: "paseo-provider-dsh", version: "0.1.0" },
      providerProtocol: PROVIDER_PROTOCOL_VERSION,
    };
    init = await client.request("bridge/initialize", params, 30_000);
  } catch (error) {
    client.close("handshake failed");
    await channel.close();
    if (error instanceof BridgeRpcError && error.code === RPC_ERROR.unsupported) {
      throw new Error(
        `DeepSeek Harness bridge is incompatible: ${error.message}. Reinstall the bridge for this dsh version (see docs/INSTALL.md).`,
      );
    }
    throw error;
  }
  if (closedReason !== undefined) {
    await channel.close();
    throw new Error(`DeepSeek Harness bridge closed during handshake: ${closedReason}`);
  }
  input.log(`bridge ready: dsh ${init.dshVersion}, bridge ${init.bridgeVersion}`);

  const state: ConnectionState = {
    capabilities: input.capabilities,
    features: init.features,
    client,
    channel,
    sessions: new Map(),
    dshVersion: init.dshVersion,
    closed: false,
  };
  return { client, channel, state };
}

/**
 * A connection whose host starts on first use.
 *
 * `connect()` must return inside the daemon's budget, but a cold DeepSeek Harness
 * boot is slower than that budget. This wrapper returns immediately, starts the
 * host when the first input actually needs it, and serialises concurrent starts so
 * a burst of inputs (catalog + sessions on open) boots exactly one host.
 */
function createLazyConnection(input: {
  capabilities: readonly string[];
  startHost: typeof startHost;
  requestTimeoutMs?: number;
  launch?: LaunchOverride;
  env?: Readonly<Record<string, string>>;
  log(message: string): void;
}): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  let starting: Promise<{ client: BridgeClient; channel: BridgeChannel; state: ConnectionState }> | undefined;
  let live: { client: BridgeClient; channel: BridgeChannel; state: ConnectionState } | undefined;
  let closed = false;
  /** Events produced before the host exists are buffered, then flushed in order. */
  const buffered: ProviderEvent[] = [];

  const emit = (event: ProviderEvent): void => {
    if (closed) return;
    if (live === undefined) {
      buffered.push(event);
      if (buffered.length > 256) buffered.shift();
      return;
    }
    for (const listener of listeners) listener(event);
  };

  const ready = async (): Promise<{ client: BridgeClient; channel: BridgeChannel; state: ConnectionState }> => {
    if (live !== undefined) return live;
    if (starting !== undefined) return starting;
    starting = (async () => {
      const opened = await openConnection({
        capabilities: input.capabilities,
        startHost: input.startHost,
        ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
        ...(input.launch !== undefined ? { launch: input.launch } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        log: input.log,
      });
      live = opened;
      // Replay anything buffered while the host was starting, then stream live.
      const pending = buffered.splice(0);
      for (const event of pending) {
        for (const listener of listeners) listener(event);
      }
      return opened;
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
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
      if (current !== undefined) {
        for (const session of current.state.sessions.values()) {
          for (const detach of session.detachers) {
            try {
              detach();
            } catch {
              // Already detached.
            }
          }
        }
        current.state.sessions.clear();
        current.client.close("provider connection closed");
        await current.channel.close();
      }
      await starting?.catch(() => undefined);
      listeners.clear();
    },
    async send(message) {
      if (closed) throw new Error("DeepSeek Harness provider connection is closed");
      try {
        // Closing needs no host; everything else does.
        if (message.type === "session.close" && live === undefined) {
          emit({ type: "session.closed", sessionId: message.sessionId });
          emit({ type: "request.completed", requestId: message.requestId });
          return;
        }
        const opened = await ready();
        await dispatch(message, {
          client: opened.client,
          state: opened.state,
          emit,
          log: input.log,
        });
      } catch (error) {
        failInput(message, emit, error);
      }
    },
  };
}

/**
 * Build the `ProviderConnection` Paseo drives for an already-started host.
 *
 * Retained for tests and for callers that own the host lifecycle directly.
 */
function createConnection(input: {
  client: BridgeClient;
  channel: BridgeChannel;
  state: ConnectionState;
  log(message: string): void;
}): ProviderConnection {
  const { client, channel, state, log } = input;
  const listeners = new Set<(event: ProviderEvent) => void>();

  const emit = (event: ProviderEvent): void => {
    if (state.closed) return;
    for (const listener of listeners) listener(event);
  };

  // A lost channel is a runtime failure, not a silent stall: every open session
  // is told so Paseo can offer recovery instead of leaving a spinner forever.
  client.on("bridge/notice", (params) => {
    const sessionId = params.sessionId;
    if (sessionId === undefined) return;
    const session = findSessionByDshId(state, sessionId);
    if (session === undefined) return;
    emit({
      type: "session.notice",
      sessionId: session.id,
      notice: {
        id: `bridge-${Date.now()}`,
        severity: params.level,
        title: params.message,
        ...(params.code !== undefined ? { description: params.code } : {}),
      },
    });
  });

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities: state.capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      for (const session of state.sessions.values()) {
        for (const detach of session.detachers) {
          try {
            detach();
          } catch {
            // A handler already gone is not an error.
          }
        }
      }
      state.sessions.clear();
      client.close("provider connection closed");
      await channel.close();
      listeners.clear();
    },
    async send(input) {
      if (state.closed) throw new Error("DeepSeek Harness provider connection is closed");
      try {
        await dispatch(input, { client, state, emit, log });
      } catch (error) {
        failInput(input, emit, error);
      }
    },
  };
}

/** Find a Paseo session by its DSH session id. */
function findSessionByDshId(state: ConnectionState, dshSessionId: string): PaseoSession | undefined {
  for (const session of state.sessions.values()) {
    if (session.dshSessionId === dshSessionId) return session;
  }
  return undefined;
}

/**
 * Report a failed input with the error discipline the daemon expects: a prompt
 * failure is per-message, a request failure is per-request, and anything else
 * with a session is a runtime failure.
 */
function failInput(input: ProviderInput, emit: (event: ProviderEvent) => void, error: unknown): void {
  const failure = describeError(error);
  if (input.type === "session.prompt") {
    emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: failure },
    });
    return;
  }
  if ("requestId" in input && input.requestId !== undefined) {
    emit({ type: "request.failed", requestId: input.requestId, error: failure });
    return;
  }
  if ("sessionId" in input) {
    emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
  }
}

/** Normalize any thrown value into Paseo's error shape. */
function describeError(error: unknown): { message: string; code?: string; diagnostic?: string } {
  if (error instanceof BridgeRpcError) {
    return {
      message: error.message,
      code: error.code === RPC_ERROR.domain ? "dsh/domain" : error.code === RPC_ERROR.unsupported ? "dsh/unsupported" : "dsh/bridge",
      ...(typeof error.data === "string" ? { diagnostic: error.data } : {}),
    };
  }
  if (error instanceof HostStartError) {
    return { message: error.message, code: "dsh/host-start", diagnostic: error.diagnostic.slice(0, 4_000) };
  }
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack !== undefined ? { diagnostic: error.stack.slice(0, 2_000) } : {}) };
  }
  return { message: String(error) };
}

/** Dispatch one Paseo input to the bridge. */
async function dispatch(
  input: ProviderInput,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): Promise<void> {
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
      // Conversation-level revert is a DSH fork at the requested cut; file-level
      // revert has no DSH equivalent, so it is refused rather than faked.
      const session = requireSession(state, input.sessionId);
      if (input.scope === "files") {
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: "DeepSeek Harness has no file-level revert; use conversation revert instead", code: "dsh/unsupported" },
        });
        return;
      }
      const atSeq = typeof input.token === "object" && input.token !== null && typeof (input.token as { seq?: unknown }).seq === "number"
        ? ((input.token as { seq: number }).seq)
        : undefined;
      const forked = await client.request("session/fork", {
        sessionId: session.dshSessionId,
        ...(atSeq !== undefined ? { atSeq } : {}),
      });
      emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: `fork-${Date.now()}`,
          severity: "info",
          title: "Session forked",
          description: `DeepSeek Harness created ${forked.sessionId} at the requested point.`,
        },
      });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      // DSH has no native archive flag; refusing keeps Paseo's state honest.
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: {
          message: `${input.type} is not supported by the DeepSeek Harness provider`,
          code: "dsh/unsupported",
        },
      });
      return;
    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      if (session !== undefined) {
        for (const detach of session.detachers) {
          try {
            detach();
          } catch {
            // Ignore already-detached handlers.
          }
        }
        state.sessions.delete(input.sessionId);
        await client.request("session/release", { sessionId: session.dshSessionId }).catch(() => undefined);
      }
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
  }
}

/** Reject a call for an unknown session in the same way the daemon's adapters do. */
function requireSession(state: ConnectionState, sessionId: string): PaseoSession {
  const session = state.sessions.get(sessionId);
  if (session === undefined) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

/** Build the provider catalogue from the bridge's real model catalogue. */
async function handleCatalog(
  input: Extract<ProviderInput, { type: "catalog" }>,
  context: { client: BridgeClient; state: ConnectionState; emit: (event: ProviderEvent) => void },
): Promise<void> {
  const { client, state, emit } = context;
  const models = await client.request("session/models", {}, 60_000);
  const catalog = catalogFrom(models);
  state.catalog = catalog;
  emit({ type: "catalog", requestId: input.requestId, catalog });
}

/**
 * Whether a `provider/model` id belongs to a built-in official DeepSeek route.
 *
 * The harness ships these routes itself (they need no user configuration), as
 * opposed to providers a user added to their profile. The provider uses this to
 * keep the official route as Paseo's default.
 */
export function isOfficialDeepseek(modelId: string): boolean {
  return modelId.startsWith("deepseek-official/") || modelId.startsWith("deepseek-account/");
}

/** Map a DSH model catalogue onto Paseo's catalogue shape. */
export function catalogFrom(models: SessionModelsResult): ProviderCatalog {
  const providerModels: ProviderModel[] = [];
  for (const group of models.groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? [];
      const thinkingOptions: ProviderThinkingOption[] = efforts.map((effort) => ({
        id: `${group.id}/${model.id}/${effort.id}`,
        label: effort.name,
        ...(effort.description !== undefined ? { description: effort.description } : {}),
        ...(models.default.reasoningEffort === effort.id &&
        models.default.provider === group.id &&
        models.default.model === model.id
          ? { isDefault: true }
          : {}),
        metadata: { provider: group.id, model: model.id, effort: effort.id },
      }));
      providerModels.push({
        id: `${group.id}/${model.id}`,
        label: model.name,
        description: model.description ?? group.name,
        ...(models.default.provider === group.id && models.default.model === model.id
          ? { isDefault: true }
          : {}),
        metadata: { provider: group.id, model: model.id },
        ...(thinkingOptions.length > 0
          ? {
              thinkingOptions,
              ...(model.reasoning?.defaultEffort !== undefined
                ? { defaultThinkingOptionId: `${group.id}/${model.id}/${model.reasoning.defaultEffort}` }
                : {}),
            }
          : {}),
      });
    }
  }
  const modes: ProviderMode[] = [
    {
      id: MODE_BUILD,
      label: "Build",
      description: "Implement changes directly.",
    },
    {
      id: MODE_PLAN,
      label: "Plan",
      description: "DeepSeek Harness plan mode: explore and present a plan for approval.",
    },
  ];
  // Default model policy. The product requirement is that Paseo starts on the
  // official DeepSeek route even when the profile inherits third-party providers
  // (the inherited rows stay selectable but never become the implicit default).
  // The order is: an explicit official DeepSeek default, then any other group,
  // then the first listed model.
  const officialDefault =
    providerModels.find((model) => model.isDefault === true && isOfficialDeepseek(model.id)) ??
    providerModels.find((model) => isOfficialDeepseek(model.id) && model.id.endsWith("/deepseek-flash")) ??
    providerModels.find((model) => isOfficialDeepseek(model.id)) ??
    providerModels.find((model) => model.isDefault === true) ??
    providerModels[0];
  return {
    models: providerModels,
    modes,
    ...(officialDefault !== undefined ? { defaultModel: officialDefault.id } : {}),
    defaultMode: MODE_BUILD,
  };
}

/** List sessions the DSH home already holds, so history is reachable from Paseo. */
async function handleSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  context: { client: BridgeClient; state: ConnectionState; emit: (event: ProviderEvent) => void; log(message: string): void },
): Promise<void> {
  const { client, emit, log } = context;
  try {
    const list = await client.request("sessions/list", { ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: list.items
        .filter((item) => item.origin !== "subagent")
        .map((item) => ({
          persistence: writePersisted({ dshSessionId: item.sessionId, cwd: item.cwd ?? "" }),
          cwd: item.cwd ?? "",
          ...(item.sessionId.length > 0 ? { title: `DeepSeek Harness ${item.sessionId.slice(-8)}` } : {}),
          ...(item.updatedAt > 0 ? { updatedAt: new Date(item.updatedAt).toISOString() } : {}),
        })),
    });
  } catch (error) {
    // Listing is an enhancement: a bridge without history support still works.
    log(`session listing failed: ${describeError(error).message}`);
    emit({ type: "sessions", requestId: input.requestId, sessions: [] });
  }
}

/** Open (or restore) one session. */
async function handleOpen(
  input: Extract<ProviderInput, { type: "session.open" }>,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): Promise<void> {
  const { client, state, emit, log } = context;
  if (state.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  const persisted = readPersisted(input.persistence);
  let dshSessionId: string;
  let cwd = input.config.cwd;
  let reused = false;

  if (persisted !== undefined) {
    // Restore the real DSH session rather than creating a new one: this is what
    // keeps history, and it is why the native id is persisted in the first place.
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
      ...(input.config.title !== undefined ? { title: input.config.title } : {}),
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
    ...(input.config.title !== undefined ? { title: input.config.title } : {}),
    cwd,
  });
  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });

  // Wire this session's events before replaying any history.
  attachSessionRouting(session, context);

  // Replay history through the official page surface (never by parsing logs).
  if (input.history === "replay" && persisted !== undefined) {
    try {
      // `page` needs a durable cut; the session's persisted watermark is the
      // highest sequence the DSH log had when it was last saved, which is what a
      // restore should replay up to.
      const page = await client.request("session/page", {
        sessionId: dshSessionId,
        throughSeq: persisted.lastSeq ?? Number.MAX_SAFE_INTEGER,
        maxMessages: 60,
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

  // Publish the real config state: models, modes, thinking options and the
  // permission presets the host actually offers.
  // Apply the user's actual selection to DSH BEFORE publishing config.
  //
  // Paseo sends its choice in `session.open.config`, but storing it in
  // `session.config` and echoing it back is not the same as using it: without this
  // call the harness keeps running `agent-default-model` while the Paseo composer
  // shows the user's pick. That is the "selected qwen but got another model"
  // symptom.
  await applyInitialSelection(session, context, input.config);

  await publishConfig(session, context, "config");

  // Slash commands are real DSH commands, so Paseo can expose them verbatim.
  try {
    const commands = await client.request("session/commands", { sessionId: dshSessionId });
    emit({
      type: "session.commands",
      sessionId: session.id,
      commands: commands.commands.map((command) => ({
        name: command.name,
        description: command.description.length > 0 ? command.description : command.name,
      })),
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
        title: "Reused a blank DeepSeek Harness session",
      },
    });
  }
}

/** Mint a DSH session id deterministically from the Paseo id. */
function newDshSessionIdFor(paseoSessionId: string): string {
  // A v4-shaped id derived from the Paseo id keeps ids stable across a re-open
  // of the same Paseo session while staying in DSH's `session-<uuid>` shape.
  const hex = Buffer.from(paseoSessionId).toString("hex").padEnd(32, "0").slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `session-${uuid}`;
}

/** Route the bridge's notifications for one session. */
function attachSessionRouting(
  session: PaseoSession,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): void {
  const { client, emit, log } = context;
  const dshId = session.dshSessionId;

  // Durable events: the authoritative timeline.
  const offEvent = client.on("session/event", (params) => {
    if (params.sessionId === dshId) {
      onSessionEvent(session, params.event, context);
      return;
    }
    // A child session's events are forwarded into its Paseo sub-session.
    const child = findChildSession(context.state, params.sessionId);
    if (child !== undefined && child.parentSessionId === dshId) {
      onChildEvent(child.paseoSessionId, params.event, context);
    }
  });

  // Live status changes.
  const offStatus = client.on("session/status", (params) => {
    if (params.sessionId !== dshId) return;
    if (params.status === "running" && session.activeTurnId === null) {
      session.turnCount += 1;
      session.activeTurnId = `turn-${session.turnCount}`;
      emit({ type: "session.turn", sessionId: session.id, turnId: session.activeTurnId, state: "started" });
    }
  });

  // Assistant deltas: Paseo appends per messageId, so these are forwarded as-is.
  const offStream = client.on("session/assistantStream", (params) => {
    if (params.sessionId !== dshId) return;
    onAssistantFrame(session, params.frame, emit);
  });

  // Tool approvals.
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
        ...(params.reason !== undefined
          ? { description: params.reason }
          : params.displayReason !== undefined
            ? { description: params.displayReason.en ?? Object.values(params.displayReason)[0] ?? "" }
            : {}),
        ...(params.input !== undefined ? { input: args as never } : {}),
        detail: toolDetail(params.toolName, args as Record<string, unknown>),
        actions: [
          { id: "allow-once", label: "Allow once", behavior: "allow", variant: "primary" },
          { id: "reject-once", label: "Reject", behavior: "deny", variant: "danger" },
        ],
        metadata: { dshRequestId: params.requestId, sessionId: dshId },
      },
    });
  });

  const offPermissionResolved = client.on("permission/resolved", (params) => {
    if (params.sessionId !== dshId) return;
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionId(dshId, params.requestId) });
  });

  // Interactive questions travel the same permission channel as kind "question".
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
        actions: params.questions
          .flatMap((question) => question.options ?? [])
          .map((option, index) => ({
            id: `option-${index}`,
            label: option.label,
            behavior: "allow" as const,
            variant: "secondary" as const,
          })),
        metadata: {
          dshRequestId: params.requestId,
          sessionId: dshId,
          questions: params.questions as never,
        },
      },
    });
  });

  const offQuestionResolved = client.on("questions/resolved", (params) => {
    if (params.sessionId !== dshId) return;
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: questionId(dshId, params.requestId) });
  });

  // Subagent lifecycle: children arrive as Paseo sub-sessions.
  const offSubStart = client.on("subagent/started", (params) => {
    if (params.parentSessionId !== dshId) return;
    openChildSession(session, params, context);
  });

  const offSubEnd = client.on("subagent/finished", (params) => {
    if (params.parentSessionId !== dshId) return;
    const child = findChildSession(context.state, params.childSessionId);
    if (child === undefined) return;
    emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "tool_call",
        id: child.toolCallId !== undefined ? toolItemId(dshId, child.toolCallId) : `dsh:${dshId}:sub:${params.childSessionId}`,
        callId: child.toolCallId ?? params.childSessionId,
        name: "subagent",
        detail: {
          type: "sub_agent",
          ...(child.label !== undefined ? { description: child.label } : {}),
          childSessionId: params.childSessionId,
          log: params.lastAssistantText ?? "",
        },
        ...(params.status === "ok"
          ? { status: "completed" as const, error: null }
          : { status: "failed" as const, error: { message: params.stopReason } }),
      },
    });
  });

  // Model / permission / plan changes flow back into the Paseo config block.
  const offConfig = client.on("session/configChanged", (params) => {
    if (params.sessionId !== dshId) return;
    if (params.models.selected !== undefined) {
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
      settings: { ...session.config.settings, [SETTING_PERMISSION]: params.permission.current },
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
    offPermissionChanged,
  );
  log(`session ${session.id} routed to ${dshId}`);
}

/** Find a live child session record by DSH child id. */
function findChildSession(
  state: ConnectionState,
  childDshId: string,
): { paseoSessionId: string; parentSessionId: string; toolCallId?: string; label?: string } | undefined {
  for (const session of state.sessions.values()) {
    for (const [childId, meta] of session.children) {
      if (childId === childDshId) {
        return { paseoSessionId: childId, parentSessionId: session.dshSessionId, ...meta };
      }
    }
  }
  return undefined;
}

/** Forward one child session's durable event into its Paseo sub-session. */
function onChildEvent(paseoChildId: string, event: SessionWireEvent, context: { emit: (event: ProviderEvent) => void }): void {
  for (const item of timelineItemsFor(paseoChildId, event)) {
    context.emit({ type: "timeline.item", sessionId: paseoChildId, item });
  }
}

/** Declare a child session as a Paseo sub-session and stream its timeline. */
function openChildSession(
  parent: PaseoSession,
  params: { childSessionId: string; toolCallId?: string; label?: string; provider?: string },
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): void {
  const { emit } = context;
  if (parent.children.has(params.childSessionId)) return;
  parent.children.set(params.childSessionId, {
    ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
  });

  const paseoChildId = `sub:${params.childSessionId}`;
  context.state.sessions.set(paseoChildId, parent);

  emit({
    type: "session.opened",
    sessionId: paseoChildId,
    parentSessionId: parent.id,
    ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
    capabilities: [],
    restoration: "parent",
    ...(params.label !== undefined ? { title: params.label } : {}),
    cwd: parent.cwd,
  });
  emit({ type: "session.ready", sessionId: paseoChildId });

  // The parent's tool card is updated in place so the sub-agent is visible where
  // it was launched, matching DSH's own presentation.
  if (params.toolCallId !== undefined) {
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
          ...(params.label !== undefined ? { description: params.label } : {}),
          ...(params.provider !== undefined ? { subAgentType: params.provider } : {}),
          childSessionId: params.childSessionId,
          log: "",
        },
        status: "running",
        error: null,
      },
    });
  }
}

/** Map one durable DSH event onto Paseo timeline + turn state. */
function onSessionEvent(
  session: PaseoSession,
  event: SessionWireEvent,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): void {
  const { emit } = context;
  session.lastSeq = Math.max(session.lastSeq, event.seq);

  // Turn boundaries drive Paseo's turn lifecycle.
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
      ...(failed ? { error: { message: typeof event.data.message === "string" ? event.data.message : "turn failed" } } : {}),
    });
    // Persistence advances per turn so a restart resumes at the right cut.
    emit({ type: "session.persistence", sessionId: session.id, persistence: session.persistence });
    return;
  }
  // Model selection is durable state, so Paseo's config block follows it.
  if (event.type === "model/selection") {
    const provider = event.data.provider;
    const model = event.data.model;
    if (typeof provider === "string" && typeof model === "string") {
      const effort = event.data.reasoningEffort;
      session.config = {
        ...session.config,
        model: `${provider}/${model}`,
        ...(typeof effort === "string" ? { thinkingOption: `${provider}/${model}/${effort}` } : {}),
      };
    }
    return;
  }
  // Plan mode is real durable state; mirror it as the Paseo mode.
  if (event.type === "plan/mode") {
    const active = event.data.active === true;
    session.config = { ...session.config, mode: active ? MODE_PLAN : MODE_BUILD };
    void publishConfig(session, context, "plan-mode-event");
    return;
  }
  // Permission preset changes update the settings block.
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

/** Forward one assistant stream frame as a Paseo timeline delta. */
function onAssistantFrame(
  session: PaseoSession,
  frame: AssistantStreamFrame,
  emit: (event: ProviderEvent) => void,
): void {
  if (frame.type !== "chunk") return;
  const chunk = frame.chunk;
  if (typeof chunk !== "object" || chunk === null) return;
  const body = chunk as Record<string, unknown>;
  const type = typeof body.type === "string" ? body.type : "";
  const text =
    typeof body.text === "string"
      ? body.text
      : typeof body.delta === "string"
        ? body.delta
        : typeof body.content === "string"
          ? body.content
          : undefined;
  if (text === undefined || text.length === 0) return;

  if (type === "text-delta" || type === "text") {
    emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "assistant_message",
        id: `dsh:${session.dshSessionId}:assistant:${frame.attemptId}`,
        text,
        messageId: frame.attemptId,
      },
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
        text,
      },
    });
  }
}

/** Publish the current config state to Paseo. */
async function publishConfig(
  session: PaseoSession,
  context: { client: BridgeClient; emit: (event: ProviderEvent) => void; log(message: string): void },
  reason: string,
): Promise<void> {
  const { client, emit, log } = context;
  try {
    const [models, permission] = await Promise.all([
      client.request("session/models", { sessionId: session.dshSessionId }, 60_000),
      client.request("session/permission", { sessionId: session.dshSessionId }).catch(() => undefined),
    ]);
    const providerModels = catalogFrom(models).models;
    // Prefer the selection the harness actually holds. After a restore this is the
    // only source of truth: `session.config` starts from what Paseo sent, which may
    // be empty, while DSH persisted the model with the session log. Without this the
    // Paseo composer showed no model for a resumed session even though the harness
    // was running one.
    if (models.selected !== undefined && session.config.model === undefined) {
      applySelectionToConfig(session, models);
    }
    const config: ProviderConfigState = {
      ...(session.config.model !== undefined ? { model: session.config.model } : {}),
      ...(session.config.mode !== undefined ? { mode: session.config.mode } : {}),
      ...(session.config.thinkingOption !== undefined ? { thinkingOption: session.config.thinkingOption } : {}),
      models: providerModels,
      modes: catalogFrom(models).modes,
      thinkingOptions: providerModels.flatMap((model) => model.thinkingOptions ?? []),
      settings: permissionSettings(permission),
    };
    emit({ type: "session.config", sessionId: session.id, config });
  } catch (error) {
    log(`config publication failed (${reason}): ${describeError(error).message}`);
  }
}

/** Build the settings block from the host's real permission preset catalogue. */
function permissionSettings(permission: SessionPermissionResult | undefined): ProviderSetting[] {
  if (permission === undefined || permission.options.length === 0) return [];
  return [
    {
      type: "select",
      id: SETTING_PERMISSION,
      label: "Permissions",
      description: "DeepSeek Harness sandbox and approval preset.",
      value: permission.current,
      options: permission.options.map((option) => ({ label: option.label, value: option.name })),
    },
  ];
}

/** Apply a selected model/effort pair to the session config from the bridge's answer. */
function applySelectionToConfig(session: PaseoSession, models: SessionModelsResult): void {
  const selected = models.selected;
  if (selected === undefined) return;
  session.config = {
    ...session.config,
    model: `${selected.provider}/${selected.model}`,
    ...(selected.reasoningEffort !== undefined
      ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` }
      : {}),
  };
}

/** Handle one user turn. */
async function handlePrompt(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): Promise<void> {
  const { client, emit, log } = context;
  const session = requireSession(context.state, input.sessionId);
  const { prompt } = input;

  // Steering requires a live turn; DSH refuses it otherwise, so refuse first
  // with a message Paseo can show.
  if (prompt.delivery === "steer") {
    if (session.activeTurnId === null) {
      emit({
        type: "session.prompt_result",
        sessionId: session.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "There is no active turn to steer" } },
      });
      return;
    }
    await admitPrompt(session, input, "steer", context);
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "steer", turnId: session.activeTurnId },
    });
    return;
  }

  // Slash commands are real DSH commands.
  if (prompt.input.type === "command") {
    const name = prompt.input.name;
    const args = prompt.input.arguments;
    // `/plan` is the native plan-mode switch, so it maps onto the same seam the
    // config UI uses instead of being forwarded as text.
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
            title: result.active ? "Plan mode on" : "Plan mode off",
          },
        });
        emit({
          type: "session.prompt_result",
          sessionId: session.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "completed" },
        });
      } catch (error) {
        emit({
          type: "session.prompt_result",
          sessionId: session.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: describeError(error) },
        });
      }
      return;
    }
    // Any other DSH command runs through the prompt path so DSH logs it exactly
    // as its own UI would.
    const text = `/${name}${args.length > 0 ? ` ${args}` : ""}`;
    await admitPrompt(session, { ...input, prompt: { ...prompt, input: { type: "message", content: [{ type: "text", text }] } } }, "queue", context);
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "completed" },
    });
    return;
  }

  if (prompt.input.type !== "message") {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: { message: "Unsupported prompt input" } },
    });
    return;
  }

  // Build the model-facing content from real Paseo parts only.
  const content = prompt.input.content
    .map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image") {
        return { type: "image" as const, mediaType: part.mimeType, data: part.data };
      }
      // Rich attachments (forge/github/review/text/uploaded_file) carry a text
      // body we can forward; anything without one is dropped rather than
      // replaced by a description the model would mistake for user content.
      const body = (part as { text?: unknown }).text;
      if (typeof body === "string" && body.length > 0) {
        return { type: "text" as const, text: body };
      }
      return undefined;
    })
    .filter((part): part is NonNullable<typeof part> => part !== undefined);

  if (content.length === 0) {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: { message: "Prompt carried no content DeepSeek Harness can accept" } },
    });
    return;
  }

  // Ensure the model is selected before the first prompt (DSH refuses otherwise).
  await ensureModelSelected(session, context);

  try {
    await client.request("session/prompt", {
      sessionId: session.dshSessionId,
      requestId: prompt.clientMessageId,
      mode: "queue",
      content,
    });
  } catch (error) {
    emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: describeError(error) },
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
    result: { type: "turn", turnId },
  });
  emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
  log(`turn ${turnId} admitted on ${session.dshSessionId}`);
}

/** Admit a prompt without emitting a turn result (steer path). */
async function admitPrompt(
  session: PaseoSession,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  mode: "queue" | "steer",
  context: { client: BridgeClient; log(message: string): void },
): Promise<void> {
  const { prompt } = input;
  if (prompt.input.type !== "message") return;
  const content = prompt.input.content
    .map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image") return { type: "image" as const, mediaType: part.mimeType, data: part.data };
      if ("text" in part && typeof part.text === "string") return { type: "text" as const, text: part.text };
      return undefined;
    })
    .filter((part): part is NonNullable<typeof part> => part !== undefined);
  await context.client.request("session/prompt", {
    sessionId: session.dshSessionId,
    requestId: prompt.clientMessageId,
    mode,
    content,
  });
}

/** Select the host's default model once, when the session has none. */
async function ensureModelSelected(
  session: PaseoSession,
  context: { client: BridgeClient; log(message: string): void },
): Promise<void> {
  if (session.config.model !== undefined) return;
  const models = await context.client.request("session/models", { sessionId: session.dshSessionId }, 60_000);
  if (models.selected !== undefined) {
    applySelectionToConfig(session, models);
    return;
  }
  const selected = await context.client.request("session/selectModel", {
    sessionId: session.dshSessionId,
    provider: models.default.provider,
    model: models.default.model,
    ...(models.default.reasoningEffort !== undefined ? { reasoningEffort: models.default.reasoningEffort } : {}),
  });
  session.config = {
    ...session.config,
    model: `${selected.provider}/${selected.model}`,
    ...(selected.reasoningEffort !== undefined
      ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` }
      : {}),
  };
  context.log(`selected default model ${session.config.model}`);
}

/** Answer one permission request from Paseo. */
async function answerPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  session: PaseoSession,
  context: { client: BridgeClient; emit: (event: ProviderEvent) => void },
): Promise<void> {
  const { client, emit } = context;
  const permissionIdValue = input.permissionId;
  const isQuestion = permissionIdValue.includes(":question:");
  if (isQuestion) {
    // Questions carry their answers in `updatedInput`; a deny cancels the ask.
    const answers =
      input.response.behavior === "allow" && input.response.updatedInput !== undefined
        ? readQuestionAnswersFromInput(input.response.updatedInput)
        : [];
    await client.request("questions/answer", {
      requestId: extractBridgeId(permissionIdValue),
      answers,
    });
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionIdValue });
    return;
  }
  const outcome =
    input.response.behavior === "allow"
      ? "allowed-once"
      : input.response.interrupt === true
        ? "cancelled"
        : "rejected";
  await client.request("permission/answer", {
    requestId: extractBridgeId(permissionIdValue),
    outcome,
  });
  emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: permissionIdValue });
}

/** Strip the Paseo namespacing off a permission id to get the bridge request id. */
function extractBridgeId(paseoPermissionId: string): string {
  const parts = paseoPermissionId.split(":");
  return parts[parts.length - 1] ?? paseoPermissionId;
}

/** Read question answers out of a Paseo `updatedInput` payload. */
function readQuestionAnswersFromInput(input: Readonly<Record<string, unknown>>): readonly { selected: readonly string[]; text?: string }[] {
  const answers = input.answers;
  if (!Array.isArray(answers)) {
    const selected = input.selected;
    if (Array.isArray(selected)) {
      return [{ selected: selected.filter((item): item is string => typeof item === "string") }];
    }
    return [];
  }
  return answers
    .map((answer) => {
      if (typeof answer !== "object" || answer === null) return undefined;
      const record = answer as { selected?: unknown; text?: unknown };
      const selected = Array.isArray(record.selected)
        ? record.selected.filter((item): item is string => typeof item === "string")
        : [];
      return { selected, ...(typeof record.text === "string" ? { text: record.text } : {}) };
    })
    .filter((answer): answer is NonNullable<typeof answer> => answer !== undefined);
}

/** Apply a config change from Paseo to DSH. */
async function handleConfigure(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
): Promise<void> {
  const { client, emit, log } = context;
  const session = requireSession(context.state, input.sessionId);
  const changes = input.changes;

  // Resolve ids against the live catalogue: a DSH model id may itself contain
  // slashes, so the provider/model boundary cannot be found by splitting blindly.
  const liveModels = await client
    .request("session/models", { sessionId: session.dshSessionId }, 60_000)
    .catch(() => undefined);
  const catalogue = {
    modelIds: (liveModels?.groups ?? []).flatMap((group) =>
      group.models.map((model) => `${group.id}/${model.id}`),
    ),
    providers: (liveModels?.groups ?? []).map((group) => group.id),
    effortsOf: (modelId: string): readonly string[] => {
      const slash = modelId.indexOf("/");
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      const group = (liveModels?.groups ?? []).find((candidate) => candidate.id === provider);
      const found = group?.models.find((candidate) => candidate.id === model);
      return (found?.reasoning?.efforts ?? []).map((effort) => effort.id);
    },
  };

  // Model and thinking effort: Paseo encodes both in one id pair.
  // `model` is "provider/model" and `thinkingOption` is "provider/model/effort".
  if (changes.model !== undefined && changes.model !== null) {
    const parsed = splitModelId(changes.model, catalogue);
    if (parsed === undefined) {
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `Unrecognized model id: ${changes.model}`, code: "dsh/invalid-model" },
      });
      return;
    }
    const effort =
      changes.thinkingOption !== undefined
        ? changes.thinkingOption === null
          ? undefined
          : splitModelId(changes.thinkingOption, catalogue)?.effort
        : splitModelId(session.config.thinkingOption ?? "", catalogue)?.effort;
    try {
      const selected = await client.request("session/selectModel", {
        sessionId: session.dshSessionId,
        provider: parsed.provider,
        model: parsed.model,
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      });
      session.config = {
        ...session.config,
        model: `${selected.provider}/${selected.model}`,
        ...(selected.reasoningEffort !== undefined
          ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` }
          : { thinkingOption: undefined }),
      };
    } catch (error) {
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: describeError(error),
      });
      return;
    }
  } else if (changes.thinkingOption !== undefined) {
    // Effort-only change: re-apply the current model with the new effort.
    const current = splitModelId(session.config.model ?? "", catalogue);
    const effort =
      changes.thinkingOption === null ? undefined : splitModelId(changes.thinkingOption, catalogue)?.effort;
    if (current !== undefined) {
      try {
        const selected = await client.request("session/selectModel", {
          sessionId: session.dshSessionId,
          provider: current.provider,
          model: current.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        });
        session.config = {
          ...session.config,
          model: `${selected.provider}/${selected.model}`,
          ...(selected.reasoningEffort !== undefined
            ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` }
            : { thinkingOption: undefined }),
        };
      } catch (error) {
        emit({ type: "request.failed", requestId: input.requestId, error: describeError(error) });
        return;
      }
    }
  }

  // Mode: plan/build maps to the native plan-mode seam.
  if (changes.mode !== undefined && changes.mode !== null) {
    const active = changes.mode === MODE_PLAN;
    try {
      const result = await client.request("session/setPlanMode", { sessionId: session.dshSessionId, active });
      session.config = { ...session.config, mode: result.active ? MODE_PLAN : MODE_BUILD };
    } catch (error) {
      emit({ type: "request.failed", requestId: input.requestId, error: describeError(error) });
      return;
    }
  }

  // Settings: the permission preset is the only setting this provider exposes.
  if (changes.settings !== undefined) {
    const preset = changes.settings[SETTING_PERMISSION];
    if (typeof preset === "string") {
      try {
        const applied = await client.request("session/setPermission", {
          sessionId: session.dshSessionId,
          name: preset,
        });
        session.config = {
          ...session.config,
          settings: { ...session.config.settings, [SETTING_PERMISSION]: applied.applied },
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

/**
 * Push the selection Paseo opened the session with into DSH.
 *
 * Four independent pieces of state can arrive on `session.open.config`, and each
 * maps to a different native seam:
 *
 * - `model` (+ `thinkingOption`): one `session/selectModel` call, because DSH
 *   installs provider, model and reasoning effort as a single durable selection.
 * - `mode`: the plan/build switch, through the same command seam the config UI uses.
 * - `settings["permission-preset"]`: the sandbox/approval preset.
 *
 * Every failure is reported as a notice instead of being swallowed: a silent
 * failure here reproduces exactly the bug this function exists to fix.
 */
async function applyInitialSelection(
  session: PaseoSession,
  context: {
    client: BridgeClient;
    state: ConnectionState;
    emit: (event: ProviderEvent) => void;
    log(message: string): void;
  },
  config: ProviderSessionConfig,
): Promise<void> {
  const { client, emit, log } = context;

  // --- model + reasoning effort -------------------------------------------
  if (typeof config.model === "string" && config.model.length > 0) {
    const catalogue = await readCatalogue(client, session.dshSessionId).catch(() => undefined);
    const resolved = splitModelId(
      config.model,
      catalogue === undefined
        ? undefined
        : {
            modelIds: catalogue.modelIds,
            providers: catalogue.providers,
            effortsOf: catalogue.effortsOf,
          },
    );
    // The effort arrives as its own Paseo id ("provider/model/effort"); fall back
    // to a trailing effort on the model id when the dedicated field is absent.
    const effort =
      (typeof config.thinkingOption === "string" && config.thinkingOption.length > 0
        ? splitModelId(
            config.thinkingOption,
            catalogue === undefined
              ? undefined
              : {
                  modelIds: catalogue.modelIds,
                  providers: catalogue.providers,
                  effortsOf: catalogue.effortsOf,
                },
          )?.effort
        : undefined) ?? resolved?.effort;

    if (resolved === undefined) {
      log(`session.open carried an unusable model id: ${config.model}`);
      emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: `model-unparsed-${Date.now()}`,
          severity: "warning",
          title: "DeepSeek Harness did not apply the selected model",
          description: `Unrecognized model id "${config.model}". The harness is using its configured default.`,
        },
      });
    } else {
      try {
        const selected = await client.request("session/selectModel", {
          sessionId: session.dshSessionId,
          provider: resolved.provider,
          model: resolved.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        });
        session.config = {
          ...session.config,
          model: `${selected.provider}/${selected.model}`,
          ...(selected.reasoningEffort !== undefined
            ? { thinkingOption: `${selected.provider}/${selected.model}/${selected.reasoningEffort}` }
            : {}),
        };
        log(`applied model ${selected.provider}/${selected.model}${effort !== undefined ? ` @${effort}` : ""}`);
      } catch (error) {
        // A rejected effort must not silently become a different effort: retry once
        // without it and tell the user what actually happened.
        const described = describeError(error);
        log(`selectModel failed: ${described.message}`);
        emit({
          type: "session.notice",
          sessionId: session.id,
          notice: {
            id: `model-not-applied-${Date.now()}`,
            severity: "warning",
            title: "DeepSeek Harness rejected the selected model or effort",
            description: described.message,
          },
        });
        try {
          const selected = await client.request("session/selectModel", {
            sessionId: session.dshSessionId,
            provider: resolved.provider,
            model: resolved.model,
          });
          session.config = { ...session.config, model: `${selected.provider}/${selected.model}` };
        } catch {
          // Leave the harness default in place; the notice above already said so.
        }
      }
    }
  }

  // --- plan / build mode ---------------------------------------------------
  if (typeof config.mode === "string" && config.mode.length > 0) {
    const wantsPlan = config.mode === MODE_PLAN;
    try {
      const result = await client.request("session/setPlanMode", {
        sessionId: session.dshSessionId,
        active: wantsPlan,
      });
      session.config = { ...session.config, mode: result.active ? MODE_PLAN : MODE_BUILD };
    } catch (error) {
      log(`initial plan mode switch failed: ${describeError(error).message}`);
    }
  }

  // --- permission preset ---------------------------------------------------
  const preset = config.settings[SETTING_PERMISSION];
  if (typeof preset === "string" && preset.length > 0) {
    try {
      const applied = await client.request("session/setPermission", {
        sessionId: session.dshSessionId,
        name: preset,
      });
      session.config = {
        ...session.config,
        settings: { ...session.config.settings, [SETTING_PERMISSION]: applied.applied },
      };
    } catch (error) {
      log(`initial permission preset failed: ${describeError(error).message}`);
    }
  }
}

/**
 * Read the live model catalogue and index it for id resolution.
 *
 * Shared by the open path and `session.configure`: both must resolve a Paseo model
 * id against real harness ids, because those ids legitimately contain slashes.
 */
export async function readCatalogue(
  client: BridgeClient,
  sessionId?: string,
): Promise<{
  modelIds: string[];
  providers: string[];
  effortsOf: (modelId: string) => readonly string[];
}> {
  const models = await client.request(
    "session/models",
    sessionId !== undefined ? { sessionId } : {},
    60_000,
  );
  return {
    modelIds: models.groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`)),
    providers: models.groups.map((group) => group.id),
    effortsOf: (modelId: string): readonly string[] => {
      const slash = modelId.indexOf("/");
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      const group = models.groups.find((candidate) => candidate.id === provider);
      const found = group?.models.find((candidate) => candidate.id === model);
      return (found?.reasoning?.efforts ?? []).map((effort) => effort.id);
    },
  };
}

/**
 * Split a Paseo model id into the DSH provider/model/effort triple.
 *
 * Naively splitting on "/" is wrong: DSH model ids legitimately contain slashes
 * (a custom provider can declare `workbuddy/deepseek-v4.1-flash`), so
 * `magpie/workbuddy/glm-5.3` means provider `magpie`, model
 * `workbuddy/glm-5.3` - not model `workbuddy` with effort `glm-5.3`.
 *
 * The split is therefore resolved against the live catalogue rather than guessed:
 * the longest provider prefix that names a known provider wins, and any trailing
 * segment that matches an advertised reasoning effort is taken as the effort.
 *
 * @param value - a Paseo model id, optionally with a `dsh/` provider prefix and an
 *   optional trailing effort (for example `dsh/magpie/workbuddy/glm-5.3/high`).
 * @param catalogue - known model ids and provider names, from the last catalogue read.
 * @returns the resolved triple, or undefined when the value cannot be matched.
 */
export function splitModelId(
  value: string,
  catalogue?: {
    /** Every `provider/model` id the harness currently advertises. */
    modelIds?: readonly string[];
    /** Every provider name the harness currently advertises. */
    providers?: readonly string[];
    /** Effort ids advertised for the resolved model. */
    effortsOf?: (modelId: string) => readonly string[];
  },
): { provider: string; model: string; effort?: string } | undefined {
  if (value.length === 0) return undefined;

  // Paseo may prefix the provider name; drop a leading "dsh/" when present.
  const trimmed = value.startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;

  // Exact match against a known id first, optionally with an effort suffix.
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

  // No catalogue hit: use the longest advertised provider prefix.
  const providers = [...(catalogue?.providers ?? [])].sort((left, right) => right.length - left.length);
  for (const provider of providers) {
    if (!trimmed.startsWith(`${provider}/`)) continue;
    const rest = trimmed.slice(provider.length + 1);
    if (rest.length === 0) continue;
    const efforts = catalogue?.effortsOf?.(`${provider}/${rest}`) ?? [];
    // Only treat the trailing segment as an effort when the harness advertises it.
    const slash = rest.lastIndexOf("/");
    if (slash > 0) {
      const tail = rest.slice(slash + 1);
      if (efforts.includes(tail)) {
        return { provider, model: rest.slice(0, slash), effort: tail };
      }
    }
    return { provider, model: rest };
  }

  // Last resort, and only when the value looks like a plain `provider/model`.
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

