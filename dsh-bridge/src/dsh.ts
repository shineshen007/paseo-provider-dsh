/**
 * Structural types for the DSH host services this bridge consumes.
 *
 * These are declared here, structurally, instead of importing
 * `@deepseek-ai/dsh-*` types at build time on purpose:
 *
 * - The bridge is installed into a DSH profile whose dependency tree belongs to
 *   DSH (`pnpm add` in the profile). Adding package-level type dependencies would
 *   pin a second copy of DSH's type graph into this package and drift.
 * - The bridge must tolerate a DSH minor upgrade. Every member is optional here
 *   and probed at runtime, so a missing seam downgrades one feature instead of
 *   failing to load the plugin.
 *
 * Each shape mirrors a definition verified against the installed
 * `@deepseek-ai/dsh` 0.2.1-rc.2 declarations; `docs/FINDINGS.md` records
 * where each was confirmed.
 */

import type { Context } from "@deepseek-ai/cordis";

/** DSH session identity (`session-<uuid>`). */
export type DshSessionId = string;

/** DSH session event as delivered by `ctx.on('session/event')`. */
export interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}

/** The live session object exposed on an Agent. */
export interface DshSession {
  readonly id: DshSessionId;
  readonly cwd?: string;
  readonly createdAt?: number;
  readonly parentSession?: DshSessionId;
  readonly origin?: "subagent";
}

/** One live agent, as `ctx.agents.get(id)` returns. */
export interface DshAgent {
  readonly session: DshSession;
  readonly status?: string;
  readonly id?: string;
}

/** Model selection installed for a session. */
export interface DshModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** One reasoning-effort choice on an exact model route. */
export interface DshModelReasoningEffort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** Selectable reasoning metadata for one model route. */
export interface DshModelReasoning {
  readonly efforts: readonly DshModelReasoningEffort[];
  readonly defaultEffort?: string;
}

/** One model in the host catalogue. */
export interface DshModelCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: DshModelReasoning;
}

/** One provider group in the host catalogue. */
export interface DshModelProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly DshModelCatalogModel[];
}

/** Host model catalogue. */
export interface DshModelCatalog {
  readonly default: DshModelSelection;
  readonly routableProviders?: readonly string[];
  readonly groups: readonly DshModelProviderGroup[];
  readonly failures?: readonly { readonly id: string; readonly name: string; readonly message: string }[];
}

/** Durable session projection read. */
export type DshProjections =
  | { readonly kind: "sequenced"; readonly asOfSeq: number; readonly values: Record<string, unknown> }
  | { readonly kind: "migration-required"; readonly values: Record<string, unknown> }
  | null;

/** Session address accepted by history and follow calls. */
export type DshSessionAddress =
  | { readonly kind: "session"; readonly sessionId: DshSessionId }
  | {
      readonly kind: "subagent";
      readonly parentSessionId: DshSessionId;
      readonly childSessionId: DshSessionId;
      readonly mode: "one-shot" | "continuable" | "unknown";
    };

/** One durable history record. */
export interface DshHistoryRecord {
  readonly event: DshSessionEvent;
}

/** One backwards history page. */
export interface DshSessionPage {
  readonly records: readonly DshHistoryRecord[];
  readonly hasMore: boolean;
}

/** Process-local assistant stream baseline in a follow opening. */
export interface DshAssistantStreamBaseline {
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

/** One process-local assistant stream frame. */
export type DshAssistantStreamFrame =
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

/** One follow frame: opening snapshot, durable event, or assistant stream frame. */
export type DshFollowFrame =
  | {
      readonly type: "snapshot";
      readonly header: { readonly id: DshSessionId; readonly cwd?: string; readonly parentSession?: DshSessionId };
      readonly cursor: number;
      readonly records: readonly DshHistoryRecord[];
      readonly hasMore: boolean;
      readonly projections: unknown;
      readonly assistantStream?: DshAssistantStreamBaseline;
    }
  | { readonly type: "event"; readonly event: DshSessionEvent }
  | { readonly type: "assistant-stream"; readonly frame: DshAssistantStreamFrame };

/** One row of the host session list. */
export interface DshSessionSummary {
  readonly sessionId: DshSessionId;
  readonly cwd?: string;
  readonly running?: boolean;
  readonly agentAvailable?: boolean;
  readonly updatedAt?: number;
  readonly parentSessionId?: DshSessionId;
  readonly origin?: "subagent";
  readonly blank?: boolean;
}

/** One permission preset choice. */
export interface DshPermissionPresetOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

/** Permission preset catalogue. */
export interface DshPermissionCatalog {
  readonly options: readonly DshPermissionPresetOption[];
  readonly defaultOptions?: readonly DshPermissionPresetOption[];
  readonly defaultPreset?: string;
}

/** One registered slash command. */
export interface DshCommandDescriptor {
  readonly name: string;
  readonly description?: string;
}

/** Result of executing a slash command. */
export interface DshCommandExecution {
  readonly result?: { readonly kind?: string; readonly text?: string };
  readonly commandId?: string;
}

/** One child of a session's subagent catalogue. */
export interface DshSubagentChild {
  readonly childSessionId?: DshSessionId;
  readonly id?: DshSessionId;
  readonly label?: string;
  readonly description?: string;
  readonly provider?: string;
  readonly mode?: "one-shot" | "continuable" | "unknown";
  readonly status?: string;
}

/** One descendant row from `listDescendants`. */
export interface DshSubagentDescendant {
  readonly childSessionId?: DshSessionId;
  readonly parentSessionId?: DshSessionId;
  readonly label?: string;
  readonly description?: string;
  readonly provider?: string;
  readonly mode?: "one-shot" | "continuable" | "unknown";
  readonly status?: string;
  readonly diagnostic?: string;
}

/** `ctx.sessionController` — the host Session business API. */
export interface DshSessionController {
  list(request: { cursor?: string }, signal?: AbortSignal): Promise<{ items: readonly DshSessionSummary[] }>;
  create(
    request: { cwd?: string; sessionId?: DshSessionId; agentPreset?: string },
    signal?: AbortSignal,
  ): Promise<{ sessionId: DshSessionId; agentPreset?: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: DshSessionId;
      mode: "queue" | "steer";
      content: readonly unknown[];
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ accepted: true }>;
  cancel(request: { sessionId: DshSessionId }, signal?: AbortSignal): { accepted: true };
  selectModel(
    request: DshModelSelection & { sessionId: DshSessionId },
    signal?: AbortSignal,
  ): Promise<{ selected: DshModelSelection }>;
  modelCatalog(signal?: AbortSignal): Promise<DshModelCatalog>;
  projections(request: { sessionId: DshSessionId }, signal?: AbortSignal): Promise<DshProjections>;
  page(
    request: {
      address: DshSessionAddress;
      throughSeq: number;
      beforeSeq?: number;
      maxMessages?: number;
    },
    signal?: AbortSignal,
  ): Promise<DshSessionPage>;
  follow(
    request: { address: DshSessionAddress; assistantStream?: true; maxMessages?: number },
    signal?: AbortSignal,
  ): AsyncIterable<DshFollowFrame>;
  resolveAgent(sessionId: DshSessionId): Promise<unknown>;
  rename(request: { sessionId: DshSessionId; title: string }, signal?: AbortSignal): Promise<{ title: string; seq: number }>;
  fork(
    request: { sessionId: DshSessionId; atSeq?: number },
    signal?: AbortSignal,
  ): Promise<{ sessionId: DshSessionId }>;
  attachment(
    request: { sessionId: DshSessionId; attachmentId: string },
    signal?: AbortSignal,
  ): Promise<{ attachment?: { mediaType?: string }; data?: string }>;
  inspect(sessionId: DshSessionId, signal?: AbortSignal): Promise<unknown>;
}

/** The cordis Context surface this bridge relies on. */
export interface BridgeContext extends Context {
  readonly sessionController: DshSessionController;
  readonly agents: {
    get(sessionId: DshSessionId): DshAgent | undefined;
    create?(options: unknown): Promise<unknown>;
    resume?(options: unknown): Promise<unknown>;
  };
  readonly sessions: {
    get?(sessionId: DshSessionId): DshSession | undefined;
  };
  readonly sessionPersistence?: unknown;
  readonly llm?: unknown;
  readonly approval?: {
    request?(request: unknown): Promise<string>;
    setPolicy?(agent: DshAgent, policy: "ask" | "never"): void;
  };
  readonly permissionPresets?: {
    catalog?(): DshPermissionCatalog;
    names?: readonly string[];
    defaultPreset?: string;
    current?(session: DshSession): string;
    set?(session: DshSession, name: string): void;
    resolve?(name: string): unknown;
  };
  readonly userQuestions?: {
    ask?(request: unknown): Promise<unknown>;
  };
  readonly subagents?: {
    listChildren?(parentSessionId: DshSessionId, signal?: AbortSignal): Promise<readonly DshSubagentChild[]>;
    listDescendants?(rootSessionId: DshSessionId, signal?: AbortSignal): Promise<readonly DshSubagentDescendant[]>;
    cancel?(request: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  readonly commands?: {
    list(agent: DshAgent): readonly DshCommandDescriptor[];
    execute(agent: DshAgent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<DshCommandExecution | undefined>;
  };
  readonly sessionProjections?: unknown;
}
