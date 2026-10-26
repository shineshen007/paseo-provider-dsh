/**
 * Session supervision for the bridge host.
 *
 * One `SessionSupervisor` owns the bridge's view of every session it has
 * opened: the live follow stream, the durable cursor, pending approvals and
 * questions, and the child session catalogue. It is the only place that talks
 * to `ctx.sessionController`, so the RPC layer stays a thin dispatcher and the
 * Paseo plugin never sees DSH call shapes.
 *
 * Invariants this file upholds, each learned from a P0 measurement recorded in
 * `docs/FINDINGS.md`:
 *
 * - Every Remote call receives a real `AbortSignal`; several DSH methods throw
 *   on `undefined` (`page`, `prompt`, `projections`).
 * - `page()` is only ever asked for `throughSeq <= follow cursor`; a larger cut
 *   is refused by the host with `page through seq … is past cursor …`.
 * - History and live events are read through the official follow/page surface,
 *   never by parsing the compressed `session.v4.jsonl.zstd` on disk.
 * - Approvals are answered through the `approval/request` waterfall and every
 *   answer resolves to DSH's closed outcome vocabulary.
 */

import { randomUUID } from "node:crypto";
import { BridgeError, RPC_ERROR, isRecord } from "./rpc.ts";
import type {
  BridgeContext,
  DshAgent,
  DshFollowFrame,
  DshHistoryRecord,
  DshModelCatalog,
  DshSessionEvent,
  DshSessionId,
  DshSessionSummary,
} from "./dsh.ts";
import type {
  AssistantStreamFrame,
  BridgeNotificationMap,
  DshSubagentChild,
  PromptContentPart,
  SessionModelsResult,
  SessionPermissionResult,
  SessionWireEvent,
} from "./wire.ts";

/** Narrow DSH's event `data` to a record for the wire. */
function asData(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Project one durable DSH event onto the wire envelope (identity-preserving). */
function toWireEvent(event: DshSessionEvent): SessionWireEvent {
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: asData(event.data),
    ...(event.ignorable === true ? { ignorable: true as const } : {}),
    ...(event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
    ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
  };
}

/** One open follow stream. */
interface FollowState {
  readonly id: string;
  readonly sessionId: DshSessionId;
  readonly controller: AbortController;
  cursor: number;
  /** Whether this follow streams process-local assistant deltas. */
  readonly assistantStream: boolean;
}

/** One session the bridge currently holds a live agent for. */
interface OwnedSession {
  readonly sessionId: DshSessionId;
  cwd: string;
  readonly follow: FollowState;
  readonly createdAt: number;
  /** Set when the durable log cannot be read safely (newer harness). */
  migrationRequired: boolean;
}

/** A pending approval awaiting a Paseo answer. */
interface PendingApproval {
  readonly id: string;
  readonly sessionId: DshSessionId;
  readonly toolName: string;
  readonly callId?: string;
  readonly settle: (outcome: "allowed-once" | "rejected" | "cancelled") => void;
  readonly agent: DshAgent;
}

/** A pending interactive question awaiting a Paseo answer. */
interface PendingQuestion {
  readonly id: string;
  readonly sessionId: DshSessionId;
  readonly callId?: string;
  readonly settle: (answers: readonly { selected: readonly string[]; text?: string }[]) => void;
  readonly agent: DshAgent;
}

/** Collaborators the supervisor needs from the plugin body. */
export interface SupervisorOptions {
  ctx: BridgeContext;
  /** Emit one notification to the Paseo side. */
  notify<K extends keyof BridgeNotificationMap>(method: K, params: BridgeNotificationMap[K]): void;
  /** Bridge package version, reported in the handshake. */
  version: string;
  /** DSH home directory, reported in the handshake. */
  dshHome: string;
}

/**
 * Supervises every session the bridge has opened.
 *
 * Follow streams are started at session-open time so approvals, live events and
 * assistant deltas flow from the first turn; the durable cursor from the
 * opening snapshot is what later `page` requests are cut against.
 */
export class SessionSupervisor {
  private readonly sessions = new Map<DshSessionId, OwnedSession>();
  private readonly follows = new Map<string, FollowState>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  /** Recent `tool/call` arguments, used to enrich approval prompts. */
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  /** Child sessions observed through subagent events: child -> parent. */
  private readonly childParents = new Map<DshSessionId, DshSessionId>();
  private readonly lifetime = new AbortController();

  constructor(private readonly options: SupervisorOptions) {}

  /** Session ids this bridge currently holds. */
  get size(): number {
    return this.sessions.size;
  }

  /** Abort signal used for supervisor-owned background work. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the host events the bridge forwards.
   *
   * @returns a disposer removing every listener.
   */
  attach(): () => void {
    const { ctx } = this.options;
    const offs: Array<() => void> = [];
    // The host's `Events` interface is augmented by whichever DSH plugins are
    // composed, so event names are looked up dynamically here rather than
    // pinned to one composition's type.
    const on = (name: string, handler: (...args: never[]) => void): (() => void) =>
      (ctx as unknown as { on(event: string, listener: (...args: never[]) => void): () => void }).on(name, handler);

    offs.push(
      on("session/event", ((session: { id: DshSessionId }, event: DshSessionEvent) => {
        this.forwardEvent(session.id, event, "");
      }) as never),
    );

    offs.push(
      on("agent/status", ((payload: { agent?: DshAgent; status?: string }) => {
        const id = payload?.agent?.session?.id;
        if (id === undefined) return;
        const status = payload.status === "running" ? "running" : "idle";
        this.options.notify("session/status", { sessionId: id, status });
      }) as never),
    );

    // Approval waterfall: answer only for sessions this bridge owns, otherwise
    // delegate so another answerer (or the fail-closed default) decides.
    offs.push(
      on(
        "approval/request",
        (
          request: {
            agent?: DshAgent;
            toolName?: string;
            callId?: string;
            reason?: string;
            displayReason?: Record<string, string>;
            signal?: AbortSignal;
          },
          next: () => Promise<string>,
        ) => this.onApprovalRequest(request, next),
      ),
    );

    // Interactive questions travel the user-questions waterfall.
    offs.push(
      on(
        "user-questions/request",
        (
          request: {
            agent?: DshAgent;
            callId?: string;
            questions?: readonly {
              question?: string;
              header?: string;
              options?: readonly { label?: string; description?: string }[];
              multiSelect?: boolean;
              intent?: string;
            }[];
            signal?: AbortSignal;
          },
          next: () => Promise<unknown>,
        ) => this.onQuestionRequest(request, next),
      ),
    );

    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          // A listener disposed by its own fiber is already gone.
        }
      }
    };
  }

  /** Stop every follow stream and fail outstanding prompts. */
  async close(): Promise<void> {
    this.lifetime.abort();
    for (const follow of this.follows.values()) follow.controller.abort();
    this.follows.clear();
    for (const approval of this.approvals.values()) approval.settle("cancelled");
    this.approvals.clear();
    this.questions.clear();
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Create a fresh session under a caller-chosen DSH id. */
  async create(params: {
    sessionId: string;
    cwd: string;
    title?: string;
    agentPreset?: string;
  }): Promise<{ sessionId: DshSessionId; cwd: string; agentPreset?: string; reused: boolean }> {
    const { ctx } = this.options;
    if (!/^session-[0-9a-f-]{36}$/i.test(params.sessionId)) {
      throw new BridgeError(
        RPC_ERROR.invalidParams,
        `session id must look like "session-<uuid>", received "${params.sessionId}"`,
      );
    }
    if (this.sessions.has(params.sessionId)) {
      throw new BridgeError(RPC_ERROR.domain, `session already open: ${params.sessionId}`);
    }
    const created = await ctx.sessionController.create(
      {
        sessionId: params.sessionId as DshSessionId,
        cwd: params.cwd,
        ...(params.agentPreset !== undefined ? { agentPreset: params.agentPreset } : {}),
      },
      this.signal,
    );
    const sessionId = created.sessionId;
    if (params.title !== undefined && params.title.length > 0) {
      await this.rename(sessionId, params.title);
    }
    await this.openFollow(sessionId, true);
    const follow = this.sessions.get(sessionId);
    return {
      sessionId,
      cwd: follow?.cwd ?? params.cwd,
      ...(created.agentPreset !== undefined ? { agentPreset: created.agentPreset } : {}),
      reused: sessionId !== params.sessionId,
    };
  }

  /** Restore a persisted session by its native id. */
  async resume(params: { sessionId: string }): Promise<{
    sessionId: DshSessionId;
    cwd: string;
    lastSeq: number;
    migrationRequired: boolean;
  }> {
    const sessionId = params.sessionId as DshSessionId;
    if (this.sessions.has(sessionId)) {
      const open = this.sessions.get(sessionId)!;
      return {
        sessionId,
        cwd: open.cwd,
        lastSeq: open.follow.cursor,
        migrationRequired: open.migrationRequired,
      };
    }
    // Resolving the agent restores the persisted session without enqueueing a prompt.
    await this.options.ctx.sessionController.resolveAgent(sessionId);
    const open = await this.openFollow(sessionId, false);
    const agent = this.options.ctx.agents.get(sessionId);
    const cwd = agent?.session?.cwd ?? open.cwd;
    return {
      sessionId,
      cwd,
      lastSeq: open.follow.cursor,
      migrationRequired: open.migrationRequired,
    };
  }

  /** Whether this bridge owns a live agent for the session. */
  owns(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Release one session's follow stream and live agent reference. */
  async release(sessionId: string): Promise<void> {
    const open = this.sessions.get(sessionId as DshSessionId);
    if (open === undefined) return;
    open.follow.controller.abort();
    this.follows.delete(open.follow.id);
    this.sessions.delete(sessionId as DshSessionId);
    // DSH keeps the durable log; only this host's live agent reference is dropped.
    const agent = this.options.ctx.agents.get(sessionId as DshSessionId);
    if (agent !== undefined) {
      const disposable = agent as unknown as { dispose?: () => Promise<void> };
      try {
        await disposable.dispose?.();
      } catch {
        // Disposal of an already-idle agent is a no-op in DSH.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Prompts and cancellation
  // -------------------------------------------------------------------------

  /** Admit one prompt for a session. */
  async prompt(params: {
    sessionId: string;
    requestId: string;
    mode: "queue" | "steer";
    content: readonly PromptContentPart[];
    clientTimeZone?: string;
  }): Promise<{ accepted: true; messageId?: string }> {
    const sessionId = this.requireOwned(params.sessionId);
    const content = params.content.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      return {
        type: "image" as const,
        mediaType: part.mediaType,
        data: part.data,
        ...(part.name !== undefined ? { name: part.name } : {}),
      };
    });
    await this.options.ctx.sessionController.prompt(
      {
        requestId: params.requestId,
        sessionId,
        mode: params.mode,
        content,
        ...(params.clientTimeZone !== undefined ? { clientTimeZone: params.clientTimeZone } : {}),
      },
      this.signal,
    );
    return { accepted: true };
  }

  /** Cancel the session's active turn. */
  cancel(params: { sessionId: string }): { accepted: true } {
    const sessionId = this.requireOwned(params.sessionId);
    this.options.ctx.sessionController.cancel({ sessionId }, this.signal);
    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // Models, plan and permissions
  // -------------------------------------------------------------------------

  /** Read the host catalogue plus the selection in force for one session. */
  async models(params: { sessionId?: string }): Promise<SessionModelsResult> {
    const catalog: DshModelCatalog = await this.options.ctx.sessionController.modelCatalog(this.signal);
    const groups = catalog.groups.map((group) => ({
      id: group.id,
      name: group.name,
      models: group.models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
        ...(model.reasoning !== undefined
          ? {
              reasoning: {
                efforts: model.reasoning.efforts.map((effort) => ({
                  id: effort.id,
                  name: effort.name,
                  ...(effort.description !== undefined ? { description: effort.description } : {}),
                })),
                ...(model.reasoning.defaultEffort !== undefined ? { defaultEffort: model.reasoning.defaultEffort } : {}),
              },
            }
          : {}),
      })),
    }));
    let selected: SessionModelsResult["selected"];
    if (params.sessionId !== undefined && this.sessions.has(params.sessionId as DshSessionId)) {
      const projections = await this.projections({ sessionId: params.sessionId });
      const value = projections.values.modelSelection;
      if (isRecord(value)) {
        const next = isRecord(value.next) ? value.next : isRecord(value.lastUsed) ? value.lastUsed : undefined;
        if (next !== undefined) {
          selected = {
            provider: String(next.provider),
            model: String(next.model),
            ...(typeof next.reasoningEffort === "string" ? { reasoningEffort: next.reasoningEffort } : {}),
          };
        }
      }
    }
    return {
      default: {
        provider: catalog.default.provider,
        model: catalog.default.model,
        ...(catalog.default.reasoningEffort !== undefined
          ? { reasoningEffort: catalog.default.reasoningEffort }
          : {}),
      },
      groups,
      ...(selected !== undefined ? { selected } : {}),
    };
  }

  /** Install one model selection for a session. */
  async selectModel(params: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const sessionId = this.requireOwned(params.sessionId);
    const result = await this.options.ctx.sessionController.selectModel(
      {
        sessionId,
        provider: params.provider,
        model: params.model,
        ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
      },
      this.signal,
    );
    const selected = result.selected;
    this.options.notify("session/configChanged", {
      sessionId,
      models: await this.models({ sessionId }),
      plan: this.planOf(await this.projections({ sessionId })),
    });
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: selected.reasoningEffort } : {}),
    };
  }

  /**
   * Enter or leave native plan mode.
   *
   * Plan mode is composed per agent preset (`isolate: {planMode: true}` in the
   * web bundle), so the host root has no `ctx.planMode`. The officially
   * supported control surface is the `/plan` command, which is what the DSH Web
   * UI drives; the resulting state is read back from the `plan` projection.
   */
  async setPlanMode(params: { sessionId: string; active: boolean }): Promise<{
    active: boolean;
    outcome: "committed" | "queued" | "cancelled" | "noop";
    pending?: boolean;
  }> {
    const sessionId = this.requireOwned(params.sessionId);
    const { ctx } = this.options;
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) {
      throw new BridgeError(RPC_ERROR.domain, `session has no live agent: ${sessionId}`);
    }
    if (ctx.commands === undefined) {
      throw new BridgeError(RPC_ERROR.unsupported, "host does not expose the commands seam");
    }
    const before = this.planOf(await this.projections({ sessionId }));
    const line = params.active ? "/plan" : "/plan off";
    const execution = await ctx.commands.execute(agent, line, [], this.signal);
    const kind = execution?.result?.kind;
    if (kind === "error") {
      throw new BridgeError(RPC_ERROR.domain, execution?.result?.text ?? "plan mode switch failed");
    }
    const after = this.planOf(await this.projections({ sessionId }));
    this.options.notify("session/planChanged", {
      sessionId,
      active: after?.active ?? false,
      ...(after?.pending !== undefined ? { pending: after.pending } : {}),
    });
    const changedNow = (after?.active ?? false) === params.active;
    const outcome: "committed" | "queued" | "cancelled" | "noop" = changedNow
      ? before?.active === after?.active
        ? "noop"
        : "committed"
      : "queued";
    return {
      active: after?.active ?? false,
      outcome,
      ...(after?.pending !== undefined ? { pending: after.pending } : {}),
    };
  }

  /** Read the sandbox/approval preset state of a session. */
  permission(params: { sessionId: string }): SessionPermissionResult {
    const sessionId = this.requireOwned(params.sessionId);
    const { ctx } = this.options;
    const presets = ctx.permissionPresets;
    if (presets === undefined) {
      throw new BridgeError(RPC_ERROR.unsupported, "host does not expose permission presets");
    }
    const catalog = presets.catalog?.();
    const names = presets.names ?? catalog?.options?.map((option) => option.value) ?? [];
    const agent = ctx.agents.get(sessionId);
    const current = agent !== undefined ? (presets.current?.(agent.session) ?? presets.defaultPreset ?? "custom") : "custom";
    const fromCatalog = catalog?.options ?? [];
    const options = names.map((name) => {
      const found = fromCatalog.find((option) => option.value === name);
      return {
        name,
        label: found?.name ?? name,
        ...(found?.description !== undefined ? { description: found.description } : {}),
      };
    });
    return { current, options };
  }

  /** Apply one permission preset by name. */
  async setPermission(params: { sessionId: string; name: string }): Promise<{ applied: string }> {
    const sessionId = this.requireOwned(params.sessionId);
    const { ctx } = this.options;
    const presets = ctx.permissionPresets;
    if (presets?.set === undefined) {
      throw new BridgeError(RPC_ERROR.unsupported, "host does not expose permission presets");
    }
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) {
      throw new BridgeError(RPC_ERROR.domain, `session has no live agent: ${sessionId}`);
    }
    // `danger-full-access` is reachable only by an explicit user choice from
    // Paseo; the bridge never widens permissions on its own.
    presets.set(agent.session, params.name);
    const state = this.permission({ sessionId });
    this.options.notify("session/permissionChanged", { sessionId, permission: state });
    return { applied: state.current };
  }

  // -------------------------------------------------------------------------
  // Projections, history, follow
  // -------------------------------------------------------------------------

  /** Read durable projection values for a session. */
  async projections(params: { sessionId: string }): Promise<{
    kind: "sequenced" | "migration-required" | "absent";
    asOfSeq: number;
    values: Record<string, unknown>;
  }> {
    const sessionId = this.requireOwned(params.sessionId);
    const value = await this.options.ctx.sessionController.projections({ sessionId }, this.signal);
    if (value === null) return { kind: "absent", asOfSeq: 0, values: {} };
    if (value.kind === "migration-required") {
      return { kind: "migration-required", asOfSeq: 0, values: value.values };
    }
    return { kind: "sequenced", asOfSeq: value.asOfSeq, values: value.values };
  }

  /** Read one backwards history page, cut at the live follow cursor. */
  async page(params: {
    sessionId: string;
    throughSeq?: number;
    beforeSeq?: number;
    maxMessages?: number;
  }): Promise<{ records: readonly SessionWireEvent[]; hasMore: boolean }> {
    const sessionId = this.requireOwned(params.sessionId);
    const open = this.sessions.get(sessionId as DshSessionId)!;
    // The host rejects a cut past the follow cursor, so the cursor is the cap.
    const throughSeq = Math.min(params.throughSeq ?? open.follow.cursor, open.follow.cursor);
    const page = await this.options.ctx.sessionController.page(
      {
        address: { kind: "session", sessionId: sessionId as DshSessionId },
        throughSeq,
        ...(params.beforeSeq !== undefined ? { beforeSeq: params.beforeSeq } : {}),
        ...(params.maxMessages !== undefined ? { maxMessages: params.maxMessages } : {}),
      },
      this.signal,
    );
    return {
      records: page.records.map((record: DshHistoryRecord) => toWireEvent(record.event)),
      hasMore: page.hasMore,
    };
  }

  /** Current durable cursor of a session's follow stream. */
  cursorOf(sessionId: string): number {
    return this.sessions.get(sessionId as DshSessionId)?.follow.cursor ?? 0;
  }

  /** Read one durable image back for replayed attachments. */
  async attachment(params: { sessionId: string; attachmentId: string }): Promise<{ mediaType: string; data: string }> {
    const sessionId = this.requireOwned(params.sessionId);
    const value = await this.options.ctx.sessionController.attachment(
      { sessionId, attachmentId: params.attachmentId },
      this.signal,
    );
    return { mediaType: value.attachment?.mediaType ?? "application/octet-stream", data: value.data ?? "" };
  }

  /** Rename a session's durable title. */
  async rename(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    const result = await this.options.ctx.sessionController.rename(
      { sessionId: sessionId as DshSessionId, title },
      this.signal,
    );
    return { title: result.title, seq: result.seq };
  }

  /** Fork a session at an exact event cut. */
  async fork(params: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    this.requireOwned(params.sessionId);
    const result = await this.options.ctx.sessionController.fork(
      {
        sessionId: params.sessionId as DshSessionId,
        ...(params.atSeq !== undefined ? { atSeq: params.atSeq } : {}),
      },
      this.signal,
    );
    return { sessionId: result.sessionId };
  }

  /** List recent sessions visible in this DSH home. */
  async list(params: { cursor?: string; limit?: number }): Promise<{
    items: readonly {
      sessionId: string;
      cwd?: string;
      title?: string;
      updatedAt: number;
      running: boolean;
      live: boolean;
      parentSessionId?: string;
      origin?: "subagent";
    }[];
    nextCursor?: string;
  }> {
    const result = await this.options.ctx.sessionController.list(
      { ...(params.cursor !== undefined ? { cursor: params.cursor } : {}) },
      this.signal,
    );
    const limit = params.limit ?? result.items.length;
    const items = result.items.slice(0, limit).map((item: DshSessionSummary) => ({
      sessionId: item.sessionId,
      ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
      updatedAt: item.updatedAt ?? 0,
      running: item.running === true,
      live: this.sessions.has(item.sessionId),
      ...(item.parentSessionId !== undefined ? { parentSessionId: item.parentSessionId } : {}),
      ...(item.origin !== undefined ? { origin: item.origin } : {}),
    }));
    return { items };
  }

  /** Slash commands available to a session's agent. */
  commands(params: { sessionId: string }): { commands: readonly { name: string; description: string }[] } {
    const sessionId = this.requireOwned(params.sessionId);
    const { ctx } = this.options;
    const agent = ctx.agents.get(sessionId as DshSessionId);
    if (agent === undefined || ctx.commands === undefined) return { commands: [] };
    return {
      commands: ctx.commands.list(agent).map((command) => ({
        name: command.name,
        description: command.description ?? "",
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Subagents
  // -------------------------------------------------------------------------

  /** List direct subagent children of a parent session. */
  async children(params: { parentSessionId: string }): Promise<{ children: readonly DshSubagentChild[] }> {
    const { ctx } = this.options;
    const parentSessionId = params.parentSessionId as DshSessionId;
    const rows = await ctx.subagents?.listChildren?.(parentSessionId, this.signal);
    const children = (rows ?? []).map((row) => this.toChild(row, parentSessionId));
    for (const child of children) this.childParents.set(child.childSessionId, parentSessionId);
    return { children };
  }

  /** List reachable descendants, mirroring diagnostics as notices. */
  async descendants(params: { rootSessionId: string }): Promise<{
    children: readonly DshSubagentChild[];
    diagnostics?: readonly string[];
  }> {
    const { ctx } = this.options;
    const rootSessionId = params.rootSessionId as DshSessionId;
    const rows = await ctx.subagents?.listDescendants?.(rootSessionId, this.signal);
    const diagnostics: string[] = [];
    const children: DshSubagentChild[] = [];
    for (const row of rows ?? []) {
      const diagnostic = (row as { diagnostic?: string }).diagnostic;
      if (typeof diagnostic === "string") {
        diagnostics.push(diagnostic);
        continue;
      }
      children.push(this.toChild(row, rootSessionId));
    }
    return diagnostics.length > 0 ? { children, diagnostics } : { children };
  }

  /** Cancel one subagent run. */
  async cancelSubagent(params: { sessionId: string }): Promise<{ accepted: true }> {
    const { ctx } = this.options;
    if (ctx.subagents?.cancel === undefined) {
      throw new BridgeError(RPC_ERROR.unsupported, "host does not expose subagent cancellation");
    }
    await ctx.subagents.cancel({ sessionId: params.sessionId }, this.signal);
    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Reject a call addressed to a session this bridge does not own. */
  private requireOwned(sessionId: string): DshSessionId {
    if (!this.sessions.has(sessionId as DshSessionId)) {
      throw new BridgeError(RPC_ERROR.domain, `unknown session: ${sessionId}`);
    }
    return sessionId as DshSessionId;
  }

  /** Read the cropped plan projection view. */
  private planOf(projections: { values: Record<string, unknown> }): { active: boolean; pending?: boolean } | undefined {
    const value = projections.values.plan;
    if (!isRecord(value)) return undefined;
    return {
      active: value.active === true,
      ...(typeof value.pending === "boolean" ? { pending: value.pending } : {}),
    };
  }

  /** Convert one host child row to the wire shape without inventing fields. */
  private toChild(
    row: { childSessionId?: string; id?: string; label?: string; description?: string; provider?: string; mode?: string; status?: string },
    parentSessionId: DshSessionId,
  ): DshSubagentChild {
    const childSessionId = (row.childSessionId ?? row.id ?? "") as DshSessionId;
    const mode =
      row.mode === "one-shot" || row.mode === "continuable" || row.mode === "unknown" ? row.mode : undefined;
    const status =
      row.status === "running" || row.status === "completed" || row.status === "failed" || row.status === "cancelled"
        ? row.status
        : undefined;
    return {
      childSessionId,
      parentSessionId,
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.provider !== undefined ? { provider: row.provider } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(status !== undefined ? { status } : {}),
    };
  }

  /**
   * Open one follow stream and replay its opening snapshot.
   *
   * The snapshot's cursor is the authority for every later `page` cut, which is
   * why a follow is always started before any history request.
   */
  private async openFollow(sessionId: DshSessionId, assistantStream: boolean): Promise<OwnedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;

    const followId = randomUUID();
    const controller = new AbortController();
    const follow: FollowState = {
      id: followId,
      sessionId,
      controller,
      cursor: 0,
      assistantStream,
    };
    this.follows.set(followId, follow);

    const iterator = this.options.ctx.sessionController.follow(
      {
        address: { kind: "session", sessionId },
        ...(assistantStream ? { assistantStream: true as const } : {}),
      },
      controller.signal,
    );

    // The first frame is the snapshot; everything after streams.
    const first = await takeFirst(iterator);
    const cursor = first?.type === "snapshot" ? first.cursor : 0;
    follow.cursor = cursor;
    const owned: OwnedSession = {
      sessionId,
      cwd: first?.type === "snapshot" ? ((first.header.cwd as string | undefined) ?? "") : "",
      follow,
      createdAt: Date.now(),
      migrationRequired: false,
    };
    this.sessions.set(sessionId, owned);

    if (first?.type === "snapshot") {
      for (const record of first.records) this.forwardEvent(sessionId, record.event, followId);
      if (first.assistantStream !== undefined) {
        this.options.notify("session/assistantStream", {
          sessionId,
          followId,
          frame: {
            type: "start",
            attemptId: first.assistantStream.activeAttempt?.attemptId ?? "baseline",
            revision: first.assistantStream.revision,
            startedAfterSeq: first.assistantStream.activeAttempt?.startedAfterSeq ?? 0,
            turn: first.assistantStream.activeAttempt?.turn ?? 0,
            step: first.assistantStream.activeAttempt?.step ?? 0,
          },
        });
      }
    }

    // Pump the rest of the stream in the background for this session's lifetime.
    void this.pump(iterator, sessionId, followId, follow);
    return owned;
  }

  /** Forward every later frame of a follow stream. */
  private async pump(
    iterator: AsyncIterable<DshFollowFrame>,
    sessionId: DshSessionId,
    followId: string,
    follow: FollowState,
  ): Promise<void> {
    try {
      for await (const frame of iterator) {
        if (follow.controller.signal.aborted) break;
        switch (frame.type) {
          case "snapshot":
            follow.cursor = Math.max(follow.cursor, frame.cursor);
            break;
          case "event":
            this.forwardEvent(sessionId, frame.event, followId);
            break;
          case "assistant-stream":
            this.options.notify("session/assistantStream", {
              sessionId,
              followId,
              frame: frame.frame as AssistantStreamFrame,
            });
            break;
        }
      }
    } catch {
      // A follow ends on shutdown or supervisor close; both are expected.
    }
  }

  /** Merge one durable event into the wire notification set. */
  private forwardEvent(sessionId: DshSessionId, event: DshSessionEvent, followId: string): void {
    const open = this.sessions.get(sessionId);
    if (open !== undefined) open.follow.cursor = Math.max(open.follow.cursor, event.seq);
    const parentSessionId =
      open !== undefined && this.childParents.has(sessionId) ? this.childParents.get(sessionId) : undefined;
    this.options.notify("session/event", {
      sessionId,
      followId,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      event: toWireEvent(event),
    });
    // Retain tool arguments so an approval prompt can show what is being approved.
    if (event.type === "tool/call" && isRecord(event.data)) {
      const callId = event.data.callId;
      if (typeof callId === "string") {
        const args = event.data.arguments;
        let parsed: Record<string, unknown> | undefined;
        if (typeof args === "string") {
          try {
            const value: unknown = JSON.parse(args);
            if (isRecord(value)) parsed = value;
          } catch {
            parsed = { raw: args };
          }
        }
        if (parsed !== undefined) this.toolInputs.set(callId, parsed);
      }
    }
    // Subagent lifecycle is mirrored from the durable catalogue events.
    if (event.type === "subagent/catalog" || event.type === "subagent/descriptor") {
      this.onSubagentEvent(sessionId, event);
    }
  }

  /** Derive child linkage from the durable subagent events. */
  private onSubagentEvent(parentSessionId: DshSessionId, event: DshSessionEvent): void {
    if (!isRecord(event.data)) return;
    const data = event.data;
    const childId =
      (typeof data.childSessionId === "string" && data.childSessionId) ||
      (typeof data.childId === "string" && data.childId) ||
      (typeof data.sessionId === "string" && data.sessionId) ||
      undefined;
    if (childId === undefined || childId === parentSessionId) return;
    if (!this.childParents.has(childId as DshSessionId)) {
      this.childParents.set(childId as DshSessionId, parentSessionId);
      this.options.notify("subagent/started", {
        parentSessionId,
        childSessionId: childId,
        ...(typeof data.toolCallId === "string" ? { toolCallId: data.toolCallId } : {}),
        ...(typeof data.label === "string" ? { label: data.label } : {}),
        ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
      });
    }
  }

  /** Answer one approval request from the Paseo UI. */
  private async onApprovalRequest(
    request: {
      agent?: DshAgent;
      toolName?: string;
      callId?: string;
      reason?: string;
      displayReason?: Record<string, string>;
      signal?: AbortSignal;
    },
    next: () => Promise<string>,
  ): Promise<string> {
    const sessionId = request.agent?.session?.id;
    if (sessionId === undefined || !this.sessions.has(sessionId)) {
      // Not our session: let the host's own answerers decide.
      return next();
    }
    const id = randomUUID();
    const outcome = await new Promise<"allowed-once" | "rejected" | "cancelled">((resolve) => {
      this.approvals.set(id, {
        id,
        sessionId,
        toolName: request.toolName ?? "tool",
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        settle: resolve,
        agent: request.agent!,
      });
      request.signal?.addEventListener("abort", () => this.settleApproval(id, "cancelled"), { once: true });
      this.options.notify("permission/request", {
        requestId: id,
        sessionId,
        toolName: request.toolName ?? "tool",
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        ...(request.displayReason !== undefined ? { displayReason: request.displayReason } : {}),
        ...(request.callId !== undefined && this.toolInputs.has(request.callId)
          ? { input: this.toolInputs.get(request.callId)! }
          : {}),
      });
    });
    this.options.notify("permission/resolved", { requestId: id, sessionId, outcome });
    return outcome;
  }

  /** Resolve one pending approval exactly once. */
  private settleApproval(id: string, outcome: "allowed-once" | "rejected" | "cancelled"): void {
    const pending = this.approvals.get(id);
    if (pending === undefined) return;
    this.approvals.delete(id);
    pending.settle(outcome);
  }

  /** Answer one approval from the Paseo plugin. */
  answerApproval(params: {
    requestId: string;
    outcome: "allowed-once" | "rejected" | "cancelled";
  }): void {
    if (!this.approvals.has(params.requestId)) {
      throw new BridgeError(RPC_ERROR.domain, `no pending approval: ${params.requestId}`);
    }
    this.settleApproval(params.requestId, params.outcome);
  }

  /** Forward one interactive question request to Paseo. */
  private async onQuestionRequest(
    request: {
      agent?: DshAgent;
      callId?: string;
      questions?: readonly {
        question?: string;
        header?: string;
        options?: readonly { label?: string; description?: string }[];
        multiSelect?: boolean;
        intent?: string;
      }[];
      signal?: AbortSignal;
    },
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const sessionId = request.agent?.session?.id;
    if (sessionId === undefined || !this.sessions.has(sessionId)) return next();
    const questions = (request.questions ?? []).map((item) => ({
      question: item.question ?? "",
      ...(item.header !== undefined ? { header: item.header } : {}),
      ...(item.options !== undefined
        ? {
            options: item.options.map((option) => ({
              label: option.label ?? "",
              ...(option.description !== undefined ? { description: option.description } : {}),
            })),
          }
        : {}),
      ...(item.multiSelect !== undefined ? { multiSelect: item.multiSelect } : {}),
      ...(item.intent !== undefined ? { intent: item.intent } : {}),
    }));
    const id = randomUUID();
    const answers = await new Promise<readonly { selected: readonly string[]; text?: string }[]>((resolve) => {
      this.questions.set(id, {
        id,
        sessionId,
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        settle: resolve,
        agent: request.agent!,
      });
      request.signal?.addEventListener(
        "abort",
        () => {
          this.questions.delete(id);
          this.options.notify("questions/resolved", { requestId: id, sessionId });
          resolve([]);
        },
        { once: true },
      );
      this.options.notify("questions/request", {
        requestId: id,
        sessionId,
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        questions,
      });
    });
    // DSH expects one answer object per question, in ask order.
    return {
      answers: answers.map((answer, index) => ({
        questionIndex: index,
        selected: answer.selected,
        ...(answer.text !== undefined ? { text: answer.text } : {}),
      })),
    };
  }

  /** Answer one pending question from the Paseo plugin. */
  answerQuestion(params: {
    requestId: string;
    answers: readonly { selected: readonly string[]; text?: string }[];
  }): void {
    const pending = this.questions.get(params.requestId);
    if (pending === undefined) {
      throw new BridgeError(RPC_ERROR.domain, `no pending question: ${params.requestId}`);
    }
    this.questions.delete(params.requestId);
    pending.settle(params.answers);
    this.options.notify("questions/resolved", {
      requestId: params.requestId,
      sessionId: pending.sessionId,
    });
  }
}

/** Read only the first item of an async iterable, leaving the rest to the pump. */
async function takeFirst<T>(iterable: AsyncIterable<T>): Promise<T | undefined> {
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) return undefined;
  // Splice the already-created iterator back so the caller can drain the rest.
  (iterable as unknown as { [Symbol.asyncIterator](): AsyncIterator<T> })[Symbol.asyncIterator] = () => iterator;
  return first.value;
}
