/**
 * DSH -> Paseo mapping.
 *
 * Every function here is pure: it takes one DSH fact (a durable session event, an
 * assistant stream frame, a tool result) and returns the Paseo value it maps
 * onto. Keeping the mapping pure is what makes it testable without a DSH host,
 * and it is also the only layer allowed to know both vocabularies.
 *
 * Two rules follow from the project requirements and are enforced here:
 *
 * 1. Nothing is invented. A mapping that DSH cannot justify returns `null`
 *    rather than a plausible-looking placeholder, so Paseo never shows a mode,
 *    event or tool result that the harness did not actually produce.
 * 2. DSH identifiers survive. Assistant deltas keep one stable `messageId` per
 *    attempt, tool cards keep one stable `id` per DSH tool call, and session ids
 *    pass through untouched.
 */

import type { ProviderToolCallDetail, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { assistantItemId, reasoningItemId, toolItemId } from "./ids.ts";
import type { AssistantStreamFrame, SessionWireEvent } from "../shared/wire.ts";

/** One block in a DSH assistant message, as observed in the session log. */
interface DshContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly reasoning?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly id?: string;
}

/**
 * Flatten DSH content blocks into plain visible text, preserving block order.
 *
 * Reasoning/thinking blocks are excluded on purpose: they are surfaced as their
 * own Paseo timeline item, and folding them into the assistant text would show
 * the model's private reasoning as part of its answer.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const typed = block as DshContentBlock;
          if (typed.type === "reasoning" || typed.type === "thinking") return "";
          if (typeof typed.text === "string") return typed.text;
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && content !== null) {
    const typed = content as DshContentBlock;
    if (typeof typed.text === "string") return typed.text;
  }
  return "";
}

/** Read the reasoning text from a content block list, if the block carries any. */
function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as DshContentBlock;
    if (typed.type === "reasoning" || typed.type === "thinking") {
      if (typeof typed.text === "string") parts.push(typed.text);
      else if (typeof typed.thinking === "string") parts.push(typed.thinking);
      else if (typeof typed.reasoning === "string") parts.push(typed.reasoning);
    }
  }
  return parts.join("");
}

/** Tool names DSH exposes that Paseo renders as a shell card. */
const SHELL_TOOLS = new Set(["bash", "pwsh", "shell", "terminal", "run_command"]);
/** Tool names that read a file. */
const READ_TOOLS = new Set(["read", "read_file", "fs_read"]);
/** Tool names that edit a file with a diff. */
const EDIT_TOOLS = new Set(["edit", "str_replace", "str_replace_editor", "apply_patch", "fs_edit"]);
/** Tool names that write a file. */
const WRITE_TOOLS = new Set(["write", "write_file", "fs_write"]);
/** Tool names that search. */
const SEARCH_TOOLS = new Set(["grep", "glob", "search", "fs_search", "find"]);
/** Tool names that fetch a URL. */
const FETCH_TOOLS = new Set(["web_fetch", "fetch", "webfetch"]);
/** Tool names that delegate to a child agent. */
const SUBAGENT_TOOLS = new Set(["subagent", "subagent_fork", "task", "delegate"]);

/** Read a string field from untrusted JSON. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a number field from untrusted JSON. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a record field from untrusted JSON. */
function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse a tool argument JSON string into a record, tolerating malformed input. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return rec(raw) ?? {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return rec(parsed) ?? {};
  } catch {
    return { raw };
  }
}

/**
 * Narrow a JSON-ish value to the SDK's `JsonValue` shape.
 *
 * Tool arguments arrive as untrusted JSON, so they are structurally JSON already;
 * this cast documents that boundary instead of widening the whole function.
 */
function toJsonValue(value: Record<string, unknown>): JsonValue {
  return value as unknown as JsonValue;
}

/**
 * Build the Paseo tool detail for one DSH tool call.
 *
 * @param toolName - DSH tool name exactly as logged.
 * @param args - parsed tool arguments.
 * @param output - optional tool result text, when the result already arrived.
 * @param exitCode - optional exit code, for shell tools.
 * @returns the closest Paseo detail variant, never a fabricated one.
 */
export function toolDetail(
  toolName: string,
  args: Record<string, unknown>,
  output?: string,
  exitCode?: number | null,
  childSessionId?: string,
): ProviderToolCallDetail {
  const name = toolName.toLowerCase();
  const command = str(args.command) ?? str(args.cmd) ?? str(args.script);
  if (SHELL_TOOLS.has(name) || command !== undefined) {
    return {
      type: "shell",
      command: command ?? toolName,
      ...(str(args.cwd) !== undefined ? { cwd: str(args.cwd) } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  const filePath = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  if (READ_TOOLS.has(name) && filePath !== undefined) {
    return {
      type: "read",
      filePath,
      ...(output !== undefined ? { content: output } : {}),
      ...(num(args.offset) !== undefined ? { offset: num(args.offset) } : {}),
      ...(num(args.limit) !== undefined ? { limit: num(args.limit) } : {}),
    };
  }
  if (EDIT_TOOLS.has(name) && filePath !== undefined) {
    return {
      type: "edit",
      filePath,
      ...(str(args.old_string) !== undefined ? { oldString: str(args.old_string) } : {}),
      ...(str(args.new_string) !== undefined ? { newString: str(args.new_string) } : {}),
      ...(str(args.unified_diff) !== undefined ? { unifiedDiff: str(args.unified_diff) } : {}),
    };
  }
  if (WRITE_TOOLS.has(name) && filePath !== undefined) {
    return {
      type: "write",
      filePath,
      ...(str(args.content) !== undefined ? { content: str(args.content) } : {}),
    };
  }
  const query = str(args.pattern) ?? str(args.query) ?? str(args.glob);
  if (SEARCH_TOOLS.has(name) || (query !== undefined && FETCH_TOOLS.has(name) === false)) {
    return {
      type: "search",
      query: query ?? toolName,
      toolName: name === "web_search" ? "web_search" : name === "grep" ? "grep" : name === "glob" ? "glob" : "search",
      ...(output !== undefined ? { content: output } : {}),
      ...(num(args.numMatches) !== undefined ? { numMatches: num(args.numMatches) } : {}),
    };
  }
  const url = str(args.url);
  if (FETCH_TOOLS.has(name) && url !== undefined) {
    return {
      type: "fetch",
      url,
      ...(str(args.prompt) !== undefined ? { prompt: str(args.prompt) } : {}),
      ...(output !== undefined ? { result: output } : {}),
    };
  }
  if (SUBAGENT_TOOLS.has(name)) {
    return {
      type: "sub_agent",
      ...(str(args.subagent_type) !== undefined ? { subAgentType: str(args.subagent_type) } : {}),
      ...(str(args.description) !== undefined ? { description: str(args.description) } : {}),
      ...(str(args.prompt) !== undefined ? { description: str(args.prompt) } : {}),
      ...(childSessionId !== undefined ? { childSessionId } : {}),
      log: output ?? "",
    };
  }
  if (name === "exit_plan_mode") {
    return { type: "plan", text: str(args.plan) ?? output ?? "" };
  }
  if (url !== undefined) {
    return { type: "fetch", url, ...(output !== undefined ? { result: output } : {}) };
  }
  // Unknown tools keep their real payload rather than a guessed presentation.
  return { type: "unknown", input: toJsonValue(args), output: output ?? null };
}

/** Map one DSH tool-result payload to text plus exit code. */
export function toolResultOf(data: Record<string, unknown>): { output?: string; exitCode?: number | null; failed: boolean } {
  const message = rec(data.message);
  const content = message?.content;
  const output = textOf(content) || textOf(data.output) || undefined;
  const exitCode = num(data.exitCode) ?? num(rec(data.meta)?.exitCode) ?? null;
  const isError = message?.isError === true || rec(data.error) !== undefined;
  return {
    ...(output !== undefined ? { output } : {}),
    exitCode,
    failed: isError,
  };
}

/**
 * Convert one DSH durable event into Paseo timeline items.
 *
 * @param sessionId - owning DSH session id (used for stable ids).
 * @param event - durable DSH event.
 * @returns the items this event contributes; empty when the event is internal.
 */
export function timelineItemsFor(sessionId: string, event: SessionWireEvent): ProviderTimelineItem[] {
  const data = event.data;
  switch (event.type) {
    case "user/message": {
      const text = textOf(data.content);
      // DSH injects synthetic context as user-role messages. Only a real human
      // prompt becomes a Paseo user bubble; the rest stay model-only.
      const source = rec(data.source);
      const kind = str(source?.kind);
      if (kind !== undefined && kind !== "user" && kind !== "user-rpc") return [];
      if (text.length === 0) return [];
      return [{ type: "user_message", id: `dsh:${sessionId}:user:${event.seq}`, text }];
    }
    case "assistant/message": {
      const text = textOf(data.content);
      const reasoning = reasoningOf(data.content);
      const messageId = str(data.messageId) ?? str(data.id) ?? `seq-${event.seq}`;
      const items: ProviderTimelineItem[] = [];
      if (reasoning.length > 0) {
        items.push({
          type: "reasoning",
          id: reasoningItemId(sessionId, messageId),
          text: reasoning,
        });
      }
      if (text.length > 0) {
        items.push({
          type: "assistant_message",
          id: assistantItemId(sessionId, messageId),
          text,
          messageId,
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
          error: null,
        },
      ];
    }
    case "tool/result": {
      const message = rec(data.message);
      const callId = str(message?.toolCallId) ?? str(data.callId);
      if (callId === undefined) return [];
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
          ...(result.failed
            ? { status: "failed" as const, error: result.output ?? "tool failed" }
            : { status: "completed" as const, error: null }),
        },
      ];
    }
    case "todo/write": {
      const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : [];
      const items = todos
        .map((todo) => {
          const row = rec(todo);
          const text = str(row?.text) ?? str(row?.content) ?? "";
          if (text.length === 0) return undefined;
          const status = str(row?.status);
          return {
            text,
            completed: status === "completed" || row?.completed === true,
            ...(status === "pending" || status === "in_progress" || status === "completed"
              ? { status: status as "pending" | "in_progress" | "completed" }
              : {}),
            ...(str(row?.activeForm) !== undefined ? { activeForm: str(row?.activeForm)! } : {}),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined);
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
          trigger: "auto",
        },
      ];
    default:
      return [];
  }
}

/**
 * Convert one assistant stream chunk into a Paseo timeline delta.
 *
 * DSH streams structured chunk objects. Paseo appends text per `messageId`, so
 * only text-bearing chunks produce an item; block boundaries are consumed for
 * their state, not rendered as content.
 *
 * @returns the item plus the block kind it belongs to, or null for a frame that
 * carries no text.
 */
export function streamDeltaFor(
  sessionId: string,
  attemptId: string,
  chunk: unknown,
): { item: ProviderTimelineItem; kind: "assistant" | "reasoning" } | null {
  const body = rec(chunk);
  if (body === undefined) return null;
  const type = str(body.type);
  if (type === "text-delta" || type === "delta" || type === "text") {
    const text = str(body.text) ?? str(body.delta) ?? str(body.content);
    if (text === undefined || text.length === 0) return null;
    return {
      kind: "assistant",
      item: { type: "assistant_message", id: assistantItemId(sessionId, attemptId), text, messageId: attemptId },
    };
  }
  if (type === "reasoning-delta" || type === "thinking-delta") {
    const text = str(body.text) ?? str(body.delta) ?? str(body.thinking);
    if (text === undefined || text.length === 0) return null;
    return {
      kind: "reasoning",
      item: { type: "reasoning", id: reasoningItemId(sessionId, attemptId), text },
    };
  }
  return null;
}

/** Read the assistant text of a subagent's final output blocks. */
export function subagentOutputText(blocks: unknown): string {
  return textOf(blocks).trim();
}

/** One DSH stream frame plus its routing identity. */
export interface StreamRoute {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly chunk: unknown;
}

/** Extract the routing identity of an assistant stream frame. */
export function routeOfFrame(frame: AssistantStreamFrame): StreamRoute | undefined {
  if (frame.type === "start") {
    return { sessionId: "", attemptId: frame.attemptId, chunk: undefined };
  }
  if (frame.type === "chunk") {
    return { sessionId: "", attemptId: frame.attemptId, chunk: frame.chunk };
  }
  return undefined;
}
