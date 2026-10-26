/**
 * The Paseo-provider-dsh <-> dsh-paseo-bridge wire contract.
 *
 * This file is the single authoritative description of the private channel
 * between the Paseo plugin process (inside the Paseo daemon) and the DSH-side
 * bridge plugin (inside a dedicated `dsh` profile host that the plugin spawns
 * as a child process).
 *
 * Design rules this protocol follows, and why:
 *
 * 1. It carries DSH-native semantics, not Paseo semantics. The bridge forwards
 *    what the official DSH services report (`ctx.sessionController`,
 *    `ctx.planMode`, `ctx.approval`, `ctx.userQuestions`,
 *    `ctx.permissionPresets`, `ctx.subagents`); every Paseo-shaped decision
 *    (timeline item shape, tool detail variant, turn bookkeeping) lives in the
 *    Paseo plugin. That keeps the bridge a thin, independently upgradable
 *    adapter and prevents fake or synthesized state from leaking into either side.
 *
 * 2. Every DSH identifier is preserved verbatim. `session-<uuid>` session ids,
 *    tool call ids, message ids, attempt ids and subagent child session ids cross
 *    the wire unchanged so the Paseo side can restore the real DSH session and
 *    so both sides can be cross-checked against the DSH session log.
 *
 * 3. It is transport-agnostic JSON. The bridge serves it over newline-delimited
 *    JSON-RPC 2.0 on stdin/stdout (`@deepseek-ai/dsh-sdk-protocol`'s
 *    `JsonRpcLineTransport`), which keeps stdout protocol-only and makes the
 *    same channel work on macOS, on Ubuntu and on a Paseo Remote SSH host where
 *    the daemon and the child process live on the same machine.
 *
 * 4. Versions are explicit. `BRIDGE_WIRE_VERSION` is bumped on any breaking
 *    frame change; the handshake reports the DSH version and feature flags so a
 *    mismatched pair fails at `initialize` with an actionable diagnostic
 *    instead of misbehaving later.
 */

/** Wire protocol version. Bump on any incompatible frame change. */
export const BRIDGE_WIRE_VERSION = 1;

/** JSON-RPC method names, client (Paseo plugin) to server (bridge). */
export interface BridgeRequestMap {
  /** Handshake. Must be the first request; carries the negotiated feature set. */
  "bridge/initialize": {
    params: BridgeInitializeParams;
    result: BridgeInitializeResult;
  };
  /** Liveness and version probe; safe to call at any time. */
  "bridge/ping": { params: Record<string, never>; result: BridgePingResult };
  /** Ordered shutdown so the host can flush session logs and release locks. */
  "bridge/shutdown": { params: { reason?: string }; result: Record<string, never> };
  /** Create a fresh DSH session under a caller-chosen id, or reuse a blank one. */
  "session/create": { params: SessionCreateParams; result: SessionCreateResult };
  /** Restore a persisted DSH session by its native id. */
  "session/resume": { params: SessionResumeParams; result: SessionResumeResult };
  /** Admit one prompt: ordinary queueing or steering of the active turn. */
  "session/prompt": { params: SessionPromptParams; result: SessionPromptResult };
  /** Cancel the active turn, keeping pending inbox work. */
  "session/cancel": { params: SessionCancelParams; result: SessionCancelResult };
  /** Read one live or persisted session's projection values (plan, model, …). */
  "session/projections": { params: SessionProjectionsParams; result: SessionProjectionsResult };
  /** Read a backwards page of durable session history. */
  "session/page": { params: SessionPageParams; result: SessionPageResult };
  /** Open one live follow stream for a session (snapshot + events + assistant frames). */
  "session/follow": { params: SessionFollowParams; result: SessionFollowResult };
  /** Stop a live follow stream opened by `session/follow`. */
  "session/unfollow": { params: SessionUnfollowParams; result: Record<string, never> };
  /** Model catalog plus the durable selection in force for one session. */
  "session/models": { params: SessionModelsParams; result: SessionModelsResult };
  /** Install one model / reasoning-effort selection for a session. */
  "session/selectModel": { params: SessionSelectModelParams; result: SessionSelectModelResult };
  /** Enter or leave native DSH plan mode. */
  "session/setPlanMode": { params: SessionSetPlanModeParams; result: SessionSetPlanModeResult };
  /** Read the sandbox/approval permission preset state of a session. */
  "session/permission": { params: SessionPermissionParams; result: SessionPermissionResult };
  /** Apply one permission preset by name. */
  "session/setPermission": { params: SessionSetPermissionParams; result: SessionSetPermissionResult };
  /** Answer one pending approval request emitted earlier as a notification. */
  "permission/answer": { params: PermissionAnswerParams; result: Record<string, never> };
  /** Answer one pending interactive question request. */
  "questions/answer": { params: QuestionsAnswerParams; result: Record<string, never> };
  /** List direct subagent children of a parent session. */
  "subagents/children": { params: SubagentsChildrenParams; result: SubagentsChildrenResult };
  /** Recursively list reachable descendants (tree) of a parent session. */
  "subagents/descendants": { params: SubagentsDescendantsParams; result: SubagentsDescendantsResult };
  /** Cancel one child subagent run. */
  "subagents/cancel": { params: SubagentsCancelParams; result: SubagentsCancelResult };
  /** Enumerate recent sessions visible in this DSH home. */
  "sessions/list": { params: SessionsListParams; result: SessionsListResult };
  /** Read one image attachment proven reachable from a session log. */
  "session/attachment": { params: SessionAttachmentParams; result: SessionAttachmentResult };
  /** Rename one session's durable title. */
  "session/rename": { params: SessionRenameParams; result: SessionRenameResult };
  /** Fork a session at an exact event cut, used for conversation-level revert. */
  "session/fork": { params: SessionForkParams; result: SessionForkResult };
  /** Read the DSH slash-command catalogue for a session. */
  "session/commands": { params: SessionCommandsParams; result: SessionCommandsResult };
  /** Release one session's live agent (idle teardown without deleting history). */
  "session/release": { params: SessionReleaseParams; result: Record<string, never> };
}

/** JSON-RPC notification names, server (bridge) to client (Paseo plugin). */
export interface BridgeNotificationMap {
  /** One durable DSH session event, verbatim from the session log. */
  "session/event": SessionEventNotification;
  /** Whole-agent lifecycle transition. */
  "session/status": SessionStatusNotification;
  /** One process-local assistant stream frame (opted in per follow). */
  "session/assistantStream": AssistantStreamNotification;
  /** A pending tool approval request awaiting `permission/answer`. */
  "permission/request": PermissionRequestNotification;
  /** An approval request settled by another answerer or cancelled. */
  "permission/resolved": PermissionResolvedNotification;
  /** A pending interactive question awaiting `questions/answer`. */
  "questions/request": QuestionsRequestNotification;
  /** A question request settled elsewhere or timed out. */
  "questions/resolved": QuestionsResolvedNotification;
  /** A child subagent session was created under a parent. */
  "subagent/started": SubagentStartedNotification;
  /** A child subagent run ended. */
  "subagent/finished": SubagentFinishedNotification;
  /** Session model / reasoning catalogue or selection changed. */
  "session/configChanged": SessionConfigChangedNotification;
  /** Plan mode committed or queued a change. */
  "session/planChanged": SessionPlanChangedNotification;
  /** Permission preset changed. */
  "session/permissionChanged": SessionPermissionChangedNotification;
  /** Non-fatal bridge-level notice worth surfacing in the Paseo timeline. */
  "bridge/notice": BridgeNoticeNotification;
}

/** Names exported for runtime dispatch and tests. */
export const BRIDGE_REQUEST_NAMES = [
  "bridge/initialize",
  "bridge/ping",
  "bridge/shutdown",
  "session/create",
  "session/resume",
  "session/prompt",
  "session/cancel",
  "session/projections",
  "session/page",
  "session/follow",
  "session/unfollow",
  "session/models",
  "session/selectModel",
  "session/setPlanMode",
  "session/permission",
  "session/setPermission",
  "permission/answer",
  "questions/answer",
  "subagents/children",
  "subagents/descendants",
  "subagents/cancel",
  "sessions/list",
  "session/attachment",
  "session/rename",
  "session/fork",
  "session/commands",
  "session/release",
] as const satisfies readonly (keyof BridgeRequestMap)[];

export const BRIDGE_NOTIFICATION_NAMES = [
  "session/event",
  "session/status",
  "session/assistantStream",
  "permission/request",
  "permission/resolved",
  "questions/request",
  "questions/resolved",
  "subagent/started",
  "subagent/finished",
  "session/configChanged",
  "session/planChanged",
  "session/permissionChanged",
  "bridge/notice",
] as const satisfies readonly (keyof BridgeNotificationMap)[];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * Optional capabilities the bridge advertises. The Paseo plugin must not send a
 * request whose feature flag is missing, and must not claim a Paseo capability
 * that depends on one. This is what keeps a newer plugin usable against an older
 * installed bridge instead of failing deep inside a turn.
 */
export interface BridgeFeatures {
  /** `session/resume` restores a persisted session. */
  readonly resume: boolean;
  /** `session/follow` streams process-local assistant deltas. */
  readonly assistantStream: boolean;
  /** Native plan mode seam is mounted (`ctx.planMode`). */
  readonly planMode: boolean;
  /** Sandbox/approval presets are mounted (`ctx.permissionPresets`). */
  readonly permissionPresets: boolean;
  /** Tool approval waterfall answers are forwarded. */
  readonly approvals: boolean;
  /** Interactive question waterfall answers are forwarded. */
  readonly questions: boolean;
  /** Subagent children can be listed and cancelled. */
  readonly subagents: boolean;
  /** Backwards history pages are readable. */
  readonly historyPage: boolean;
  /** Cold session listing is readable. */
  readonly sessionList: boolean;
  /** Session forks are available for conversation-level revert. */
  readonly fork: boolean;
  /** Durable images can be read back for replayed attachments. */
  readonly attachments: boolean;
}

export interface BridgeInitializeParams {
  readonly wireVersion: number;
  /** Plugin-side identity, for logs and the version matrix in `doctor`. */
  readonly client: { readonly name: string; readonly version: string };
  /** Paseo provider protocol version the caller speaks. */
  readonly providerProtocol: number;
}

export interface BridgeInitializeResult {
  readonly wireVersion: number;
  /** Negotiated features: the intersection the bridge actually implements. */
  readonly features: BridgeFeatures;
  readonly dshVersion: string;
  /** Absolute `DSH_HOME` the bridge host is bound to. */
  readonly dshHome: string;
  /** Bridge package version. */
  readonly bridgeVersion: string;
  /** Platform facts used by `doctor` and by the Remote SSH matrix. */
  readonly platform: { readonly os: string; readonly arch: string; readonly node: string };
}

export interface BridgePingResult {
  readonly ok: true;
  readonly wireVersion: number;
  readonly dshVersion: string;
  /** Live session count held by this bridge host. */
  readonly sessions: number;
  readonly uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** DSH session identity, always the native `session-<uuid>` string. */
export type DshSessionId = string;

export interface SessionCreateParams {
  /** DSH session id to own. The bridge validates the `session-<uuid>` shape. */
  readonly sessionId: DshSessionId;
  readonly cwd: string;
  /** Durable title applied through the native rename seam when present. */
  readonly title?: string;
  /** DSH agent preset name, when the deployment composes a preset roster. */
  readonly agentPreset?: string;
}

export interface SessionCreateResult {
  readonly sessionId: DshSessionId;
  readonly cwd: string;
  readonly agentPreset?: string;
  /** True when a blank stored session under the id was reused. */
  readonly reused: boolean;
}

export interface SessionResumeParams {
  readonly sessionId: DshSessionId;
}

export interface SessionResumeResult {
  readonly sessionId: DshSessionId;
  /** Effective working directory after restore. */
  readonly cwd: string;
  /** Last durable sequence number, used as the replay watermark. */
  readonly lastSeq: number;
  /** True when the log was written by a newer harness and must not be trusted. */
  readonly migrationRequired: boolean;
}

export interface SessionReleaseParams {
  readonly sessionId: DshSessionId;
}

export interface PromptContentPartText {
  readonly type: "text";
  readonly text: string;
}

export interface PromptContentPartImage {
  readonly type: "image";
  readonly mediaType: string;
  /** Base64-encoded bytes. */
  readonly data: string;
  readonly name?: string;
}

export type PromptContentPart = PromptContentPartText | PromptContentPartImage;

export interface SessionPromptParams {
  readonly sessionId: DshSessionId;
  /** Client-minted identity persisted on the accepted user message. */
  readonly requestId: string;
  /** `queue` admits behind current work; `steer` redirects the active turn. */
  readonly mode: "queue" | "steer";
  readonly content: readonly PromptContentPart[];
  readonly clientTimeZone?: string;
}

export interface SessionPromptResult {
  readonly accepted: true;
  /** Durable message id when the bridge could observe it. */
  readonly messageId?: string;
}

export interface SessionCancelParams {
  readonly sessionId: DshSessionId;
}

export interface SessionCancelResult {
  readonly accepted: true;
}

export interface SessionProjectionsParams {
  readonly sessionId: DshSessionId;
}

/**
 * Projection values are forwarded as JSON because DSH owns extensible
 * projection keys. The Paseo plugin only reads the keys it knows
 * (`plan`, `modelSelection`, `permissionPreset`, `userQuestions`), so an
 * unknown key never breaks the mapping.
 */
export interface SessionProjectionsResult {
  readonly kind: "sequenced" | "migration-required" | "absent";
  readonly asOfSeq: number;
  readonly values: Record<string, unknown>;
}

export interface SessionPageParams {
  readonly sessionId: DshSessionId;
  /** Inclusive log cut; the follow snapshot's cursor is the usual source. */
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages?: number;
}

export interface SessionPageResult {
  readonly records: readonly SessionWireEvent[];
  readonly hasMore: boolean;
}

export interface SessionFollowParams {
  readonly sessionId: DshSessionId;
  /** Include process-local assistant delta frames. */
  readonly assistantStream: boolean;
  readonly maxMessages?: number;
}

export interface SessionFollowResult {
  /** Opaque follow handle, released by `session/unfollow` or `session/release`. */
  readonly followId: string;
  readonly cursor: number;
  /** Ordered replay records from the follow opening snapshot. */
  readonly records: readonly SessionWireEvent[];
  readonly hasMore: boolean;
  readonly projections: SessionProjectionsResult;
  /** Present when `assistantStream` was requested. */
  readonly assistantStream?: AssistantStreamBaseline;
}

export interface SessionUnfollowParams {
  readonly followId: string;
}

export interface SessionModelsParams {
  readonly sessionId?: DshSessionId;
}

export interface DshModelReasoningEffort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface DshModelCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: {
    readonly efforts: readonly DshModelReasoningEffort[];
    readonly defaultEffort?: string;
  };
}

export interface DshModelProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly DshModelCatalogModel[];
}

export interface SessionModelsResult {
  readonly default: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
  readonly groups: readonly DshModelProviderGroup[];
  /** Selection currently in force for the addressed session, when known. */
  readonly selected?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
}

export interface SessionSelectModelParams {
  readonly sessionId: DshSessionId;
  readonly provider: string;
  readonly model: string;
  /** Reasoning / thinking effort id. */
  readonly reasoningEffort?: string;
}

export interface SessionSelectModelResult {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface SessionSetPlanModeParams {
  readonly sessionId: DshSessionId;
  readonly active: boolean;
}

export interface SessionSetPlanModeResult {
  readonly active: boolean;
  /** What the DSH seam reported for this switch. */
  readonly outcome: "committed" | "queued" | "cancelled" | "noop";
  readonly pending?: boolean;
}

export interface SessionPermissionParams {
  readonly sessionId: DshSessionId;
}

export interface DshPermissionPresetOption {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** Sandbox mode knob behind the preset, when the deployment exposes it. */
  readonly sandboxMode?: string;
  /** Approval policy knob behind the preset, when the deployment exposes it. */
  readonly approvalPolicy?: string;
}

export interface SessionPermissionResult {
  readonly current: string;
  readonly options: readonly DshPermissionPresetOption[];
}

export interface SessionSetPermissionParams {
  readonly sessionId: DshSessionId;
  readonly name: string;
}

export interface SessionSetPermissionResult {
  readonly applied: string;
}

export interface SessionAttachmentParams {
  readonly sessionId: DshSessionId;
  readonly attachmentId: string;
}

export interface SessionAttachmentResult {
  readonly mediaType: string;
  readonly data: string;
}

export interface SessionRenameParams {
  readonly sessionId: DshSessionId;
  readonly title: string;
}

export interface SessionRenameResult {
  readonly title: string;
  readonly seq: number;
}

export interface SessionForkParams {
  readonly sessionId: DshSessionId;
  readonly atSeq?: number;
}

export interface SessionForkResult {
  readonly sessionId: DshSessionId;
}

export interface SessionCommandsParams {
  readonly sessionId: DshSessionId;
}

export interface SessionCommandsResult {
  readonly commands: readonly { readonly name: string; readonly description: string }[];
}

export interface SessionsListParams {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionsListResult {
  readonly items: readonly DshSessionSummary[];
  readonly nextCursor?: string;
}

export interface DshSessionSummary {
  readonly sessionId: DshSessionId;
  readonly cwd?: string;
  readonly title?: string;
  readonly updatedAt: number;
  readonly running: boolean;
  /** True when this bridge host owns a live agent for the session. */
  readonly live: boolean;
  readonly parentSessionId?: DshSessionId;
  readonly origin?: "subagent";
}

// ---------------------------------------------------------------------------
// Durable session events (subset of DSH `SessionWireEvent` we consume)
// ---------------------------------------------------------------------------

/**
 * One durable DSH session event. Fields are DSH's own envelope; `data` is
 * shape-per-type and intentionally typed as JSON here, because the Paseo side
 * narrows it per event type in `shared/mapping.ts`. Unknown types are ignored
 * rather than rejected, matching DSH's own `ignorable` contract.
 */
export interface SessionWireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}

export interface SessionEventNotification {
  readonly sessionId: DshSessionId;
  /** Present when the event belongs to a subagent child addressed by this follow. */
  readonly followId?: string;
  /** Optional parent linkage so child events can be routed without a second lookup. */
  readonly parentSessionId?: DshSessionId;
  readonly event: SessionWireEvent;
}

export interface SessionStatusNotification {
  readonly sessionId: DshSessionId;
  readonly status: "idle" | "running";
}

/** Process-local assistant stream frames, mirroring DSH's follow frames. */
export type AssistantStreamFrame =
  | {
      readonly type: "start";
      readonly attemptId: string;
      readonly revision: number;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: "chunk";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: unknown;
    }
  | {
      readonly type: "end";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | { readonly kind: "committed"; readonly eventType: string; readonly seq: number }
        | { readonly kind: "abandoned" };
    };

export interface AssistantStreamBaseline {
  readonly revision: number;
  readonly activeAttempt?: {
    readonly attemptId: string;
    readonly startedAfterSeq: number;
    readonly turn: number;
    readonly step: number;
    readonly nextIndex: number;
    readonly stream: readonly unknown[];
  };
}

export interface AssistantStreamNotification {
  readonly sessionId: DshSessionId;
  readonly followId: string;
  readonly frame: AssistantStreamFrame;
}

// ---------------------------------------------------------------------------
// Approvals and questions
// ---------------------------------------------------------------------------

/** DSH approval outcomes are a closed vocabulary; the bridge maps 1:1. */
export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface PermissionRequestNotification {
  readonly requestId: string;
  readonly sessionId: DshSessionId;
  /** DSH tool name, e.g. `bash`, `write`, `edit`. */
  readonly toolName: string;
  /** Exact tool call being decided, when the asker had one. */
  readonly callId?: string;
  readonly reason?: string;
  /** Localized presentation reason supplied by the asker. */
  readonly displayReason?: Record<string, string>;
  /** Best-effort tool argument preview, read from the matching `tool/call`. */
  readonly input?: Record<string, unknown>;
}

export interface PermissionResolvedNotification {
  readonly requestId: string;
  readonly sessionId: DshSessionId;
  readonly outcome: DshApprovalOutcome;
}

export interface PermissionAnswerParams {
  readonly requestId: string;
  /** Grant applies only to the exact requested action, as DSH requires. */
  readonly outcome: Exclude<DshApprovalOutcome, "unavailable">;
}

export interface DshQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface DshQuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly DshQuestionOption[];
  readonly multiSelect?: boolean;
  /** Presentation intent such as `plan` or `approve`. */
  readonly intent?: string;
}

export interface QuestionsRequestNotification {
  readonly requestId: string;
  readonly sessionId: DshSessionId;
  readonly callId?: string;
  readonly questions: readonly DshQuestionItem[];
}

export interface QuestionsResolvedNotification {
  readonly requestId: string;
  readonly sessionId: DshSessionId;
}

export interface QuestionsAnswerParams {
  readonly requestId: string;
  /** One answer per question, in the order the questions were asked. */
  readonly answers: readonly { readonly selected: readonly string[]; readonly text?: string }[];
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export interface SubagentStartedNotification {
  readonly parentSessionId: DshSessionId;
  readonly childSessionId: DshSessionId;
  /** Spawning tool call in the parent timeline, when known. */
  readonly toolCallId?: string;
  readonly label?: string;
  /** Subagent provider/backend name, e.g. `spawn`. */
  readonly provider?: string;
}

export interface SubagentFinishedNotification {
  readonly parentSessionId: DshSessionId;
  readonly childSessionId: DshSessionId;
  readonly status: "ok" | "error";
  readonly stopReason: string;
  /** Child's selected assistant output, flattened to text for the timeline card. */
  readonly lastAssistantText?: string;
}

export interface DshSubagentChild {
  readonly childSessionId: DshSessionId;
  readonly parentSessionId: DshSessionId;
  readonly label?: string;
  readonly description?: string;
  readonly provider?: string;
  /** `one-shot` children cannot continue; `continuable` can be resumed. */
  readonly mode?: "one-shot" | "continuable" | "unknown";
  readonly status?: "running" | "completed" | "failed" | "cancelled";
  readonly toolCallId?: string;
}

export interface SubagentsChildrenParams {
  readonly parentSessionId: DshSessionId;
}

export interface SubagentsChildrenResult {
  readonly children: readonly DshSubagentChild[];
}

export interface SubagentsDescendantsParams {
  readonly rootSessionId: DshSessionId;
}

export interface SubagentsDescendantsResult {
  readonly children: readonly DshSubagentChild[];
  /** Diagnostics for branches that could not be read, mirrored to notices. */
  readonly diagnostics?: readonly string[];
}

export interface SubagentsCancelParams {
  readonly sessionId: DshSessionId;
}

export interface SubagentsCancelResult {
  readonly accepted: true;
}

// ---------------------------------------------------------------------------
// Configuration change notifications
// ---------------------------------------------------------------------------

export interface SessionConfigChangedNotification {
  readonly sessionId: DshSessionId;
  readonly models: SessionModelsResult;
  /** Plan projection view, when the seam is mounted. */
  readonly plan?: { readonly active: boolean; readonly pending?: boolean };
}

export interface SessionPlanChangedNotification {
  readonly sessionId: DshSessionId;
  readonly active: boolean;
  readonly pending?: boolean;
}

export interface SessionPermissionChangedNotification {
  readonly sessionId: DshSessionId;
  readonly permission: SessionPermissionResult;
}

export interface BridgeNoticeNotification {
  readonly sessionId?: DshSessionId;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly code?: string;
}
