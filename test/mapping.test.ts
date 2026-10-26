/**
 * Contract tests for the DSH <-> Paseo mapping.
 *
 * These run without a Paseo daemon or a DSH host: they exercise the pure
 * translation functions and validate every value they produce against the Paseo
 * SDK's own zod schemas. That is what catches the failure mode a hand-written
 * mapping is most likely to have — producing something that type-checks but that
 * the daemon rejects at the wire boundary.
 */

import { describe, expect, it } from "vitest";
import { ProviderEventSchema, ProviderInputSchema } from "@getpaseo/plugin/server/provider";
import {
  parseArguments,
  streamDeltaFor,
  subagentOutputText,
  timelineItemsFor,
  toolDetail,
  toolResultOf,
} from "../server/mapping.ts";
import { assistantItemId, isDshSessionId, newDshSessionId, permissionId, toolItemId } from "../server/ids.ts";
import { isOfficialDeepseek, splitModelId } from "../server/provider.ts";

const SESSION = "session-11111111-1111-4111-8111-111111111111";

/** Build one durable DSH event envelope for a test. */
function event(type: string, data: Record<string, unknown>, seq = 1) {
  return { type, seq, time: 1_700_000_000_000, data };
}

describe("identity helpers", () => {
  it("mints and recognises DSH session ids", () => {
    const id = newDshSessionId();
    expect(isDshSessionId(id)).toBe(true);
    expect(isDshSessionId("not-a-session")).toBe(false);
    expect(isDshSessionId("session-xyz")).toBe(false);
  });

  it("keeps ids stable for repeated lookups", () => {
    expect(assistantItemId(SESSION, "attempt-1")).toBe(assistantItemId(SESSION, "attempt-1"));
    expect(toolItemId(SESSION, "call-1")).not.toBe(toolItemId(SESSION, "call-2"));
    expect(permissionId(SESSION, "approval-1")).toContain("approval-1");
  });
});

describe("durable event mapping", () => {
  it("maps a real user prompt to a user bubble", () => {
    const items = timelineItemsFor(
      SESSION,
      event("user/message", { content: [{ type: "text", text: "hello" }], source: { kind: "user" } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "user_message", text: "hello" });
  });

  it("does not surface injected runtime context as a user bubble", () => {
    // DSH injects system/reminder context as user-role messages; showing them as
    // human prompts would misrepresent the conversation.
    const items = timelineItemsFor(
      SESSION,
      event("user/message", { content: [{ type: "text", text: "runtime context" }], source: { kind: "time-context" } }),
    );
    expect(items).toEqual([]);
  });

  it("maps an assistant message with reasoning into two items", () => {
    const items = timelineItemsFor(
      SESSION,
      event("assistant/message", {
        messageId: "m1",
        content: [
          { type: "reasoning", text: "thinking…" },
          { type: "text", text: "answer" },
        ],
      }),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "reasoning", text: "thinking…" });
    expect(items[1]).toMatchObject({ type: "assistant_message", text: "answer", messageId: "m1" });
  });

  it("maps a tool call and its result onto one stable card id", () => {
    const call = timelineItemsFor(
      SESSION,
      event("tool/call", { callId: "c1", name: "bash", arguments: '{"command":"echo hi"}' }),
    );
    expect(call[0]).toMatchObject({
      type: "tool_call",
      id: toolItemId(SESSION, "c1"),
      status: "running",
      error: null,
      detail: { type: "shell", command: "echo hi" },
    });

    const result = timelineItemsFor(
      SESSION,
      event("tool/result", {
        message: { toolCallId: "c1", name: "bash", content: [{ type: "text", text: "hi" }], isError: false },
      }),
    );
    expect(result[0]).toMatchObject({
      type: "tool_call",
      id: toolItemId(SESSION, "c1"),
      status: "completed",
      error: null,
    });
    expect((result[0] as { detail: { type: string } }).detail.type).toBe("shell");
  });

  it("marks a failed tool result as failed with the real message", () => {
    const items = timelineItemsFor(
      SESSION,
      event("tool/result", {
        message: { toolCallId: "c2", name: "read", content: [{ type: "text", text: "ENOENT" }], isError: true },
      }),
    );
    expect(items[0]).toMatchObject({ status: "failed", error: "ENOENT" });
  });

  it("maps todo writes", () => {
    const items = timelineItemsFor(
      SESSION,
      event("todo/write", { todos: [{ text: "step 1", status: "completed" }, { text: "step 2", status: "pending" }] }),
    );
    expect(items[0]).toMatchObject({
      type: "todo",
      items: [
        { text: "step 1", completed: true, status: "completed" },
        { text: "step 2", completed: false, status: "pending" },
      ],
    });
  });

  it("ignores events with no timeline representation", () => {
    expect(timelineItemsFor(SESSION, event("request/header", { header: {} }))).toEqual([]);
    expect(timelineItemsFor(SESSION, event("turn/start", { turn: 1 }))).toEqual([]);
  });
});

describe("tool detail variants", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["bash", { command: "ls" }, "shell"],
    ["read", { path: "/tmp/a" }, "read"],
    ["edit", { path: "/tmp/a", old_string: "a", new_string: "b" }, "edit"],
    ["write", { path: "/tmp/a", content: "x" }, "write"],
    ["grep", { pattern: "TODO" }, "search"],
    ["web_fetch", { url: "https://example.com" }, "fetch"],
    ["subagent", { prompt: "do it" }, "sub_agent"],
    ["exit_plan_mode", { plan: "# plan" }, "plan"],
    ["some_mcp_tool", { arbitrary: 1 }, "unknown"],
  ];

  for (const [tool, args, expected] of cases) {
    it(`maps ${tool} to ${expected}`, () => {
      expect(toolDetail(tool, args).type).toBe(expected);
    });
  }

  it("keeps unknown tool payloads instead of guessing", () => {
    const detail = toolDetail("some_mcp_tool", { arbitrary: 1 });
    expect(detail).toMatchObject({ type: "unknown", input: { arbitrary: 1 } });
  });
});

describe("stream deltas", () => {
  it("maps a text delta to an assistant item with a stable message id", () => {
    const delta = streamDeltaFor(SESSION, "attempt-1", { type: "text-delta", text: "Hel" });
    expect(delta?.kind).toBe("assistant");
    expect(delta?.item).toMatchObject({
      type: "assistant_message",
      text: "Hel",
      messageId: "attempt-1",
      id: assistantItemId(SESSION, "attempt-1"),
    });
  });

  it("maps a reasoning delta", () => {
    const delta = streamDeltaFor(SESSION, "attempt-1", { type: "reasoning-delta", text: "hm" });
    expect(delta?.kind).toBe("reasoning");
    expect(delta?.item).toMatchObject({ type: "reasoning", text: "hm" });
  });

  it("ignores block boundary frames and empty deltas", () => {
    expect(streamDeltaFor(SESSION, "a", { type: "block-start", blockType: "text" })).toBeNull();
    expect(streamDeltaFor(SESSION, "a", { type: "text-delta", text: "" })).toBeNull();
    expect(streamDeltaFor(SESSION, "a", null)).toBeNull();
  });
});

describe("argument and result parsing", () => {
  it("parses JSON arguments and tolerates malformed input", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("not json")).toEqual({ raw: "not json" });
    expect(parseArguments(undefined)).toEqual({});
  });

  it("reads a tool result's output and failure state", () => {
    expect(
      toolResultOf({ message: { content: [{ type: "text", text: "ok" }], isError: false } }),
    ).toMatchObject({ output: "ok", failed: false });
    expect(toolResultOf({ message: { content: [], isError: true }, error: { name: "X" } }).failed).toBe(true);
  });

  it("flattens subagent output blocks", () => {
    expect(subagentOutputText([{ type: "text", text: " child said " }])).toBe("child said");
  });
});

describe("Paseo SDK schema conformance", () => {
  it("accepts every input shape the plugin sends", () => {
    const inputs = [
      { type: "catalog", requestId: "r1" },
      { type: "sessions", requestId: "r2" },
      {
        type: "session.open",
        requestId: "r3",
        sessionId: "paseo-1",
        history: "replay",
        config: {
          cwd: "/tmp",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      },
      {
        type: "session.prompt",
        sessionId: "paseo-1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hi" }] },
        },
      },
      { type: "session.interrupt", requestId: "r4", sessionId: "paseo-1" },
      {
        type: "session.permission",
        sessionId: "paseo-1",
        permissionId: "p1",
        response: { behavior: "allow" },
      },
      { type: "session.configure", requestId: "r5", sessionId: "paseo-1", changes: { model: "a/b" } },
      { type: "session.close", requestId: "r6", sessionId: "paseo-1" },
    ];
    for (const input of inputs) {
      const parsed = ProviderInputSchema.safeParse(input);
      expect(parsed.success, `input ${input.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("accepts the timeline items the mapping produces", () => {
    const items = [
      ...timelineItemsFor(SESSION, event("user/message", { content: [{ type: "text", text: "hi" }], source: { kind: "user" } })),
      ...timelineItemsFor(SESSION, event("assistant/message", { messageId: "m", content: [{ type: "text", text: "yo" }] })),
      ...timelineItemsFor(SESSION, event("tool/call", { callId: "c", name: "bash", arguments: '{"command":"true"}' })),
      ...timelineItemsFor(SESSION, event("todo/write", { todos: [{ text: "t", status: "pending" }] })),
    ];
    for (const item of items) {
      const parsed = ProviderEventSchema.safeParse({
        type: "timeline.item",
        sessionId: "paseo-1",
        item,
      });
      expect(parsed.success, `item ${item.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("accepts the session lifecycle events the provider emits", () => {
    const events = [
      {
        type: "session.opened",
        sessionId: "paseo-1",
        capabilities: ["prompt.message"],
        restoration: "core",
        cwd: "/tmp",
      },
      {
        type: "session.opened",
        sessionId: "sub:session-1",
        parentSessionId: "paseo-1",
        toolCallId: "call-1",
        capabilities: [],
        restoration: "parent",
        cwd: "/tmp",
      },
      { type: "session.ready", sessionId: "paseo-1" },
      { type: "session.turn", sessionId: "paseo-1", turnId: "turn-1", state: "started" },
      {
        type: "session.prompt_result",
        sessionId: "paseo-1",
        clientMessageId: "m1",
        result: { type: "turn", turnId: "turn-1" },
      },
      {
        type: "session.permission",
        sessionId: "paseo-1",
        request: {
          id: "perm-1",
          name: "bash",
          kind: "tool",
          title: "Allow bash?",
          actions: [{ id: "allow-once", label: "Allow once", behavior: "allow" }],
        },
      },
      { type: "session.permission_resolved", sessionId: "paseo-1", permissionId: "perm-1" },
      {
        type: "session.persistence",
        sessionId: "paseo-1",
        persistence: { version: 1, data: { dshSessionId: SESSION, cwd: "/tmp" } },
      },
      {
        type: "session.config",
        sessionId: "paseo-1",
        config: {
          models: [{ id: "deepseek-official/deepseek-flash", label: "DeepSeek-Flash" }],
          modes: [{ id: "build", label: "Build" }],
          thinkingOptions: [],
          settings: [],
        },
      },
      { type: "session.closed", sessionId: "paseo-1" },
    ];
    for (const event of events) {
      const parsed = ProviderEventSchema.safeParse(event);
      expect(parsed.success, `event ${event.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});

describe("model id resolution", () => {
  // Real DSH model ids contain slashes ("magpie/workbuddy/glm-5.3"), so the
  // provider/model boundary must come from the catalogue, not from a blind split.
  const catalogue = {
    modelIds: [
      "deepseek-official/deepseek-flash",
      "magpie/workbuddy/deepseek-v4.1-flash",
      "magpie/workbuddy/glm-5.3",
      "magpie/qoder-cn/dfmodel",
      "bonsai/models/Ternary-Bonsai-2-27B-mlx-2bit",
    ],
    providers: ["deepseek-official", "magpie", "bonsai"],
    effortsOf: (modelId: string) =>
      modelId.startsWith("deepseek-official/") ? ["off", "low", "high", "max"] : ["low", "high", "max"],
  };

  it("keeps a slash-containing model id intact", () => {
    expect(splitModelId("magpie/workbuddy/glm-5.3", catalogue)).toEqual({
      provider: "magpie",
      model: "workbuddy/glm-5.3",
    });
  });

  it("accepts a Paseo provider prefix", () => {
    expect(splitModelId("dsh/magpie/workbuddy/glm-5.3", catalogue)).toEqual({
      provider: "magpie",
      model: "workbuddy/glm-5.3",
    });
  });

  it("reads a trailing effort only when it is an advertised effort", () => {
    expect(splitModelId("magpie/workbuddy/glm-5.3/high", catalogue)).toEqual({
      provider: "magpie",
      model: "workbuddy/glm-5.3",
      effort: "high",
    });
    // "dfmodel" is part of the model id, not an effort.
    expect(splitModelId("magpie/qoder-cn/dfmodel", catalogue)).toEqual({
      provider: "magpie",
      model: "qoder-cn/dfmodel",
    });
  });

  it("handles a plain official id and its effort", () => {
    expect(splitModelId("deepseek-official/deepseek-flash", catalogue)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-flash",
    });
    expect(splitModelId("deepseek-official/deepseek-flash/max", catalogue)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-flash",
      effort: "max",
    });
  });

  it("rejects values with no provider segment", () => {
    expect(splitModelId("", catalogue)).toBeUndefined();
    expect(splitModelId("deepseek-flash", catalogue)).toBeUndefined();
  });

  it("classifies official DeepSeek routes", () => {
    expect(isOfficialDeepseek("deepseek-official/deepseek-flash")).toBe(true);
    expect(isOfficialDeepseek("deepseek-account/deepseek-v4-pro")).toBe(true);
    expect(isOfficialDeepseek("magpie/workbuddy/glm-5.3")).toBe(false);
    expect(isOfficialDeepseek("bonsai/models/x")).toBe(false);
  });
});
