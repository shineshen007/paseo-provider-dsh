/**
 * dsh-paseo-bridge — the DSH-side half of the Paseo provider.
 *
 * This is an ordinary Cordis plugin: DSH loads it from a dedicated profile and
 * it uses only public host services. It never patches DSH core, never touches
 * the user's `web`/`desktop`/`headless` profiles, and stays inert unless the
 * host process was started with `--paseo-bridge`.
 *
 * Responsibilities, and what deliberately lives elsewhere:
 *
 * - Here: translate the private channel into calls on `ctx.sessionController`,
 *   `ctx.commands`, `ctx.approval`, `ctx.userQuestions`,
 *   `ctx.permissionPresets` and `ctx.subagents`, and forward the host's durable
 *   events. That is a thin adapter, so a DSH upgrade touches this package only.
 * - In the Paseo plugin (`server/`): every Paseo-shaped decision — timeline
 *   items, tool detail variants, turn bookkeeping, capability negotiation. That
 *   keeps fake or synthesized state out of both sides.
 *
 * Transport: newline-delimited JSON-RPC over the process's stdin/stdout, which
 * is what DSH's own SDK server does. stdout is protocol-only; every diagnostic
 * goes to stderr.
 */

import { JsonRpcPeer, RPC_ERROR, BridgeError, isRecord, optionalBoolean, optionalNumber, optionalString, requireString } from "./rpc.ts";
import { SocketCarrier } from "./socket.ts";
import { SessionSupervisor } from "./supervisor.ts";
import type { BridgeContext, DshSessionId } from "./dsh.ts";
import type {
  BridgeFeatures,
  BridgeInitializeParams,
  BridgeInitializeResult,
  BridgeNotificationMap,
  PromptContentPart,
  SessionCommandsResult,
  SessionModelsResult,
  SessionPermissionResult,
  SessionProjectionsResult,
  SessionPromptResult,
  SubagentsChildrenResult,
  SubagentsDescendantsResult,
  SessionsListResult,
} from "./wire.ts";
import { BRIDGE_WIRE_VERSION } from "./wire.ts";

/** Stable Cordis plugin name. */
export const name = "paseo-bridge";

/**
 * Services required before this plugin activates.
 *
 * `planMode` is deliberately absent: the web bundle composes plan mode per
 * agent preset (`isolate: {planMode: true}`), so a root-scope injection would
 * leave this plugin permanently `pending`. Plan mode is driven through the
 * `/plan` command and read back from the `plan` projection instead.
 */
export const inject = [
  "sessionController",
  "agents",
  "sessions",
  "sessionPersistence",
  "llm",
  "approval",
  "permissionPresets",
  "userQuestions",
  "subagents",
  "commands",
  "sessionProjections",
];

/** Plugin configuration. */
export interface Config {
  /**
   * Start the stdio channel. The installer/profile keeps this `true`; the Paseo
   * provider also passes `--paseo-bridge` on the host command line, and a host
   * booted without that flag leaves the channel closed.
   */
  enabled?: boolean;
  /** Bridge package version reported in the handshake; overridden by the caller. */
  version?: string;
}

/** Bridge package version, kept in sync with package.json by scripts/build.mjs. */
declare const __BRIDGE_VERSION__: string;
const BRIDGE_VERSION = __BRIDGE_VERSION__;

/** Features this build implements. Advertised as the handshake intersection. */
const FEATURES: BridgeFeatures = {
  resume: true,
  assistantStream: true,
  planMode: true,
  permissionPresets: true,
  approvals: true,
  questions: true,
  subagents: true,
  historyPage: true,
  sessionList: true,
  fork: true,
  attachments: true,
};

/** Write one diagnostic line to stderr, never stdout. */
function log(message: string): void {
  process.stderr.write(`[paseo-bridge] ${message}\n`);
}

/**
 * Mount the bridge.
 *
 * @param ctx - host plugin context carrying the DSH services this bridge uses.
 * @param config - resolved plugin config.
 */
export function apply(ctx: BridgeContext, config: Config = {}): void {
  // The host may boot this profile without the bridge flag; stay silent then so
  // an installed profile costs nothing for ordinary DSH use.
  // Two switches must agree before any socket exists: the profile config enables
  // the bundle, and the environment names the socket path for this particular
  // host. A command-line flag is not an option because the web app's CLI rejects
  // unknown options; an env-only switch keeps ordinary `dsh web` runs untouched.
  if (config.enabled !== true) {
    log("inactive (profile config paseo-bridge.enabled is false)");
    return;
  }

  const dshHome = process.env.DSH_HOME ?? "";
  const socketPath = process.env.DSH_PASEO_BRIDGE_SOCKET ?? "";
  if (socketPath === "") {
    log("inactive (DSH_PASEO_BRIDGE_SOCKET is unset)");
    return;
  }
  const notifications: Array<[keyof BridgeNotificationMap, unknown]> = [];
  let peer: JsonRpcPeer | undefined;

  const notify = <K extends keyof BridgeNotificationMap>(method: K, params: BridgeNotificationMap[K]): void => {
    if (peer !== undefined && peer.isOpen) {
      peer.notify(method, params);
      return;
    }
    // While no client is attached the bridge keeps the most recent notices, so a
    // reconnecting Paseo plugin still learns what happened during the gap
    // instead of silently dropping state.
    notifications.push([method, params]);
    if (notifications.length > 512) notifications.shift();
  };

  const supervisor = new SessionSupervisor({ ctx, notify, version: BRIDGE_VERSION, dshHome });
  const detachEvents = supervisor.attach();

  const carrier = new SocketCarrier({
    socketPath,
    onMalformed: (line, error) => log(`malformed frame: ${String(error)} :: ${line.slice(0, 200)}`),
    onConnect: (connected) => {
      peer = connected;
      log("client attached");
      for (const [method, params] of notifications.splice(0)) {
        connected.notify(method as string, params);
      }
    },
    onDisconnect: () => {
      peer = undefined;
      log("client detached; sessions stay live for reconnect recovery");
    },
    onRequest: async (method, params, signal) =>
      dispatch(method, params, { ctx, supervisor, signal, dshHome }),
  });

  void carrier.listen().then(
    () => log(`channel listening on ${socketPath}`),
    (error: unknown) => log(`channel listen failed: ${String(error)}`),
  );

  // Disposal follows the Cordis fiber: the host removing this plugin closes the
  // channel and releases every session it held.
  ctx.effect(() => {
    return () => {
      log("disposing");
      detachEvents();
      void supervisor.close().finally(() => carrier.close());
    };
  });

  log(`ready wire=${BRIDGE_WIRE_VERSION} dshHome=${dshHome || "<unset>"} node=${process.version}`);
}

/** Dispatch context passed to every request handler. */
interface DispatchContext {
  ctx: BridgeContext;
  supervisor: SessionSupervisor;
  signal: AbortSignal;
  dshHome: string;
}

/**
 * Route one request to its handler.
 *
 * Every branch validates its own params: the Paseo plugin is trusted but the
 * channel is the boundary where a version mismatch shows up, so a malformed
 * frame must produce a precise error rather than an exception deep in DSH.
 */
async function dispatch(method: string, params: unknown, exec: DispatchContext): Promise<unknown> {
  const { supervisor } = exec;
  switch (method) {
    case "bridge/initialize": {
      const body = params as BridgeInitializeParams | undefined;
      if (!isRecord(body)) throw new BridgeError(RPC_ERROR.invalidParams, "bridge/initialize: params required");
      if (body.wireVersion !== BRIDGE_WIRE_VERSION) {
        throw new BridgeError(
          RPC_ERROR.unsupported,
          `bridge wire version mismatch: plugin speaks ${String(body.wireVersion)}, bridge speaks ${BRIDGE_WIRE_VERSION}`,
        );
      }
      const result: BridgeInitializeResult = {
        wireVersion: BRIDGE_WIRE_VERSION,
        features: FEATURES,
        dshVersion: dshVersion(),
        dshHome: exec.dshHome,
        bridgeVersion: BRIDGE_VERSION,
        platform: { os: process.platform, arch: process.arch, node: process.version },
      };
      return result;
    }
    case "bridge/ping":
      return {
        ok: true,
        wireVersion: BRIDGE_WIRE_VERSION,
        dshVersion: dshVersion(),
        sessions: supervisor.size,
        uptimeMs: Math.round(process.uptime() * 1000),
      } satisfies { ok: true; wireVersion: number; dshVersion: string; sessions: number; uptimeMs: number };
    case "bridge/shutdown":
      return {};

    case "session/create":
      return supervisor.create({
        sessionId: requireString(params, "sessionId", "session/create"),
        cwd: requireString(params, "cwd", "session/create"),
        title: optionalString(params, "title"),
        agentPreset: optionalString(params, "agentPreset"),
      });
    case "session/resume":
      return supervisor.resume({ sessionId: requireString(params, "sessionId", "session/resume") });
    case "session/release":
      await supervisor.release(requireString(params, "sessionId", "session/release"));
      return {};
    case "session/prompt": {
      const content = readPromptContent(params);
      const result: SessionPromptResult = await supervisor.prompt({
        sessionId: requireString(params, "sessionId", "session/prompt"),
        requestId: requireString(params, "requestId", "session/prompt"),
        mode: readPromptMode(params),
        content,
        clientTimeZone: optionalString(params, "clientTimeZone"),
      });
      return result;
    }
    case "session/cancel":
      return supervisor.cancel({ sessionId: requireString(params, "sessionId", "session/cancel") });
    case "session/projections": {
      const result: SessionProjectionsResult = await supervisor.projections({
        sessionId: requireString(params, "sessionId", "session/projections"),
      });
      return result;
    }
    case "session/page":
      return supervisor.page({
        sessionId: requireString(params, "sessionId", "session/page"),
        throughSeq: optionalNumber(params, "throughSeq"),
        beforeSeq: optionalNumber(params, "beforeSeq"),
        maxMessages: optionalNumber(params, "maxMessages"),
      });
    case "session/follow": {
      // Follow streams open at session.open/resume; this method re-reading them
      // is how the plugin performs reconnect recovery after a restart.
      const sessionId = requireString(params, "sessionId", "session/follow");
      const resumed = await supervisor.resume({ sessionId });
      const page = await supervisor.page({ sessionId, maxMessages: 50 });
      return {
        followId: `session:${sessionId}`,
        cursor: resumed.lastSeq,
        records: page.records,
        hasMore: page.hasMore,
        projections: await supervisor.projections({ sessionId }),
      };
    }
    case "session/unfollow":
      return {};
    case "session/models": {
      const result: SessionModelsResult = await supervisor.models({ sessionId: optionalString(params, "sessionId") });
      return result;
    }
    case "session/selectModel":
      return supervisor.selectModel({
        sessionId: requireString(params, "sessionId", "session/selectModel"),
        provider: requireString(params, "provider", "session/selectModel"),
        model: requireString(params, "model", "session/selectModel"),
        reasoningEffort: optionalString(params, "reasoningEffort"),
      });
    case "session/setPlanMode":
      return supervisor.setPlanMode({
        sessionId: requireString(params, "sessionId", "session/setPlanMode"),
        active: readBoolean(params, "active", "session/setPlanMode"),
      });
    case "session/permission": {
      const result: SessionPermissionResult = supervisor.permission({
        sessionId: requireString(params, "sessionId", "session/permission"),
      });
      return result;
    }
    case "session/setPermission":
      return supervisor.setPermission({
        sessionId: requireString(params, "sessionId", "session/setPermission"),
        name: requireString(params, "name", "session/setPermission"),
      });
    case "permission/answer":
      supervisor.answerApproval({
        requestId: requireString(params, "requestId", "permission/answer"),
        outcome: readApprovalOutcome(params),
      });
      return {};
    case "questions/answer":
      supervisor.answerQuestion({
        requestId: requireString(params, "requestId", "questions/answer"),
        answers: readQuestionAnswers(params),
      });
      return {};

    case "subagents/children": {
      const result: SubagentsChildrenResult = await supervisor.children({
        parentSessionId: requireString(params, "parentSessionId", "subagents/children"),
      });
      return result;
    }
    case "subagents/descendants": {
      const result: SubagentsDescendantsResult = await supervisor.descendants({
        rootSessionId: requireString(params, "rootSessionId", "subagents/descendants"),
      });
      return result;
    }
    case "subagents/cancel":
      return supervisor.cancelSubagent({ sessionId: requireString(params, "sessionId", "subagents/cancel") });

    case "sessions/list": {
      const result: SessionsListResult = await supervisor.list({
        cursor: optionalString(params, "cursor"),
        limit: optionalNumber(params, "limit"),
      });
      return result;
    }
    case "session/attachment":
      return supervisor.attachment({
        sessionId: requireString(params, "sessionId", "session/attachment"),
        attachmentId: requireString(params, "attachmentId", "session/attachment"),
      });
    case "session/rename":
      return supervisor.rename(
        requireString(params, "sessionId", "session/rename"),
        requireString(params, "title", "session/rename"),
      );
    case "session/fork":
      return supervisor.fork({
        sessionId: requireString(params, "sessionId", "session/fork"),
        atSeq: optionalNumber(params, "atSeq"),
      });
    case "session/commands": {
      const result: SessionCommandsResult = supervisor.commands({
        sessionId: requireString(params, "sessionId", "session/commands"),
      });
      return result;
    }
    default:
      throw new BridgeError(RPC_ERROR.methodNotFound, `unknown method: ${method}`);
  }
}

/** Read the DSH version from the host package without importing DSH internals. */
function dshVersion(): string {
  // The host binary exposes its version through the CLI; inside the plugin we
  // report the composition fact we can observe rather than guessing.
  return process.env.DSH_BRIDGE_DSH_VERSION ?? "unknown";
}

/** Validate and read the prompt content array. */
function readPromptContent(params: unknown): readonly PromptContentPart[] {
  if (!isRecord(params) || !Array.isArray(params.content) || params.content.length === 0) {
    throw new BridgeError(RPC_ERROR.invalidParams, "session/prompt: content must be a non-empty array");
  }
  return params.content.map((part, index) => {
    if (!isRecord(part)) {
      throw new BridgeError(RPC_ERROR.invalidParams, `session/prompt: content[${index}] must be an object`);
    }
    if (part.type === "text" && typeof part.text === "string") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "image" && typeof part.data === "string" && typeof part.mediaType === "string") {
      return {
        type: "image" as const,
        mediaType: part.mediaType,
        data: part.data,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      };
    }
    throw new BridgeError(
      RPC_ERROR.invalidParams,
      `session/prompt: content[${index}] must be {type:"text"} or {type:"image"}`,
    );
  });
}

/** Read the prompt delivery mode. */
function readPromptMode(params: unknown): "queue" | "steer" {
  const mode = isRecord(params) ? params.mode : undefined;
  if (mode === "queue" || mode === "steer") return mode;
  throw new BridgeError(RPC_ERROR.invalidParams, 'session/prompt: mode must be "queue" or "steer"');
}

/** Read a required boolean. */
function readBoolean(params: unknown, field: string, context: string): boolean {
  const value = optionalBoolean(params, field);
  if (value === undefined) {
    throw new BridgeError(RPC_ERROR.invalidParams, `${context}: "${field}" must be a boolean`);
  }
  return value;
}

/** Read a closed approval outcome. */
function readApprovalOutcome(params: unknown): "allowed-once" | "rejected" | "cancelled" {
  const value = isRecord(params) ? params.outcome : undefined;
  if (value === "allowed-once" || value === "rejected" || value === "cancelled") return value;
  throw new BridgeError(
    RPC_ERROR.invalidParams,
    'permission/answer: outcome must be "allowed-once", "rejected" or "cancelled"',
  );
}

/** Read question answers in ask order. */
function readQuestionAnswers(params: unknown): readonly { selected: readonly string[]; text?: string }[] {
  if (!isRecord(params) || !Array.isArray(params.answers)) {
    throw new BridgeError(RPC_ERROR.invalidParams, "questions/answer: answers must be an array");
  }
  return params.answers.map((answer, index) => {
    if (!isRecord(answer) || !Array.isArray(answer.selected)) {
      throw new BridgeError(RPC_ERROR.invalidParams, `questions/answer: answers[${index}].selected must be an array`);
    }
    const selected = answer.selected.filter((item): item is string => typeof item === "string");
    return { selected, ...(typeof answer.text === "string" ? { text: answer.text } : {}) };
  });
}

export { BRIDGE_WIRE_VERSION };
export type { DshSessionId };
