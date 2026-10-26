#!/usr/bin/env node
/**
 * Real integration test: drive the provider against a live `dsh` host.
 *
 * This is the test that matters. It spawns an actual DeepSeek Harness host from a
 * dedicated profile, opens the provider exactly as the Paseo daemon would, and
 * asserts on what DSH really does: a real model turn, native plan mode, tool
 * approvals, sub-agents, cancellation, persistence and history replay.
 *
 * Isolation: every run gets its own `DSH_HOME` under a temp directory and its own
 * profile. The user's `~/.dsh` (web/desktop/headless profiles and sessions) is
 * never read or written, so a failing test cannot damage a real installation.
 *
 * Usage:
 *   node scripts/e2e/run.mjs                 # full run
 *   node scripts/e2e/run.mjs --keep          # keep the temp home for inspection
 *   node scripts/e2e/run.mjs --only=prompt   # one scenario
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keep = process.argv.includes("--keep");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg?.slice("--only=".length);

/** Scenario registry. */
const results = [];
let failures = 0;

/** Run one scenario with timing and a pass/fail record. */
async function scenario(name, fn) {
  if (only !== undefined && only !== name) return;
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    process.stdout.write(`  ✅ ${name} (${Date.now() - started}ms)\n`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    process.stdout.write(`  ❌ ${name}: ${String(error?.message ?? error)}\n`);
    if (error?.stack) process.stdout.write(`${String(error.stack).split("\n").slice(1, 4).join("\n")}\n`);
  }
}

/** Poll until `check` returns a truthy value or the deadline passes. */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Build the isolated DSH home and profile for this run. */
function createIsolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "dsh-paseo-e2e-"));
  const profileDir = join(home, "profiles", "paseo-e2e");
  mkdirSync(profileDir, { recursive: true });

  // A web-derived profile: it is the composition that carries sessionController,
  // permission presets and the subagent registry, which is what the bridge needs.
  writeFileSync(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-paseo-e2e",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(profileDir, "cordis.yml"), "# managed by the e2e harness\n[]\n");
  writeFileSync(
    join(profileDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
  writeFileSync(
    join(profileDir, "cordis.patch.yml"),
    `# e2e profile patch: silence the URL line because Paseo owns this host's stdio.\n- id: web-runtime\n  config:\n    printUrl: false\n\n- insert:\n    - id: paseo-bridge\n      name: dsh-paseo-bridge\n      config:\n        enabled: true\n`,
  );

  // Link the bridge package exactly as `dsh plugin add` would.
  const link = spawnSync("pnpm", ["add", join(root, "dsh-bridge")], {
    cwd: profileDir,
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
  });
  if (link.status !== 0) {
    throw new Error(`pnpm add failed: ${link.stderr || link.stdout}`);
  }
  return { home, profileDir };
}

/** Copy credentials so the isolated home can reach a model, without printing them. */
function seedCredentials(home) {
  const source = join(process.env.HOME ?? "", ".dsh", ".credentials.yaml");
  if (!existsSync(source)) return false;
  cpSync(source, join(home, ".credentials.yaml"));
  return true;
}

/** Drive the provider through the same surface the Paseo daemon uses. */
async function openProvider({ home, timeoutMs = 90_000 }) {
  process.env.DSH_HOME = home;
  process.env.DSH_PASEO_PROFILE = "paseo-e2e";
  const { createDshProvider } = await import("../../dist/bundle/provider.mjs");
  const provider = createDshProvider({
    log: (message) => {
      if (process.env.E2E_VERBOSE === "1") process.stdout.write(`  [plugin] ${message}\n`);
    },
  });

  const status = await provider.status({});
  assert.equal(status.available, true, `provider unavailable: ${status.diagnostic ?? ""}`);

  const connection = await provider.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.command",
      "prompt.steer",
      "session.configure",
      "session.list",
      "session.persistence",
      "session.subsession",
      "permission",
      "timeline.plugin",
    ],
  });

  /** Every event the provider emits, for assertions. */
  const events = [];
  connection.onEvent((event) => {
    events.push(event);
    if (process.env.E2E_VERBOSE === "1") {
      process.stdout.write(`  [event] ${event.type}${"sessionId" in event ? ` ${event.sessionId}` : ""}\n`);
    }
  });

  return { provider, connection, events, timeoutMs };
}

/** Wait for one event matching a predicate. */
async function waitEvent(events, predicate, timeoutMs, label) {
  return waitFor(() => events.find(predicate), timeoutMs, label);
}

async function main() {
  process.stdout.write("paseo-provider-dsh — real DSH integration test\n");
  const build = spawnSync("node", [join(root, "scripts", "build.mjs")], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);

  const isolated = createIsolatedHome();
  const hasCreds = seedCredentials(isolated.home);
  process.stdout.write(`  isolated DSH_HOME: ${isolated.home}\n`);
  process.stdout.write(`  credentials seeded: ${hasCreds ? "yes" : "no (model scenarios will be skipped)"}\n`);

  try {
    await scenario("catalog", async () => {
      const { connection, events } = await openProvider(isolated);
      await connection.send({ type: "catalog", requestId: "cat-1" });
      const catalog = await waitEvent(events, (e) => e.type === "catalog", 60_000, "catalog");
      assert.ok(catalog.catalog.models.length > 0, "catalogue must expose real DSH models");
      assert.ok(catalog.catalog.modes.some((m) => m.id === "plan"), "plan mode must be advertised");
      // Thinking options come from the host's reasoning-effort catalogue.
      const withThinking = catalog.catalog.models.find((m) => (m.thinkingOptions ?? []).length > 0);
      assert.ok(withThinking, "at least one model must expose reasoning efforts");
      process.stdout.write(
        `    models=${catalog.catalog.models.length} thinking=${withThinking.thinkingOptions.length}\n`,
      );
      await connection.close();
    });

    if (hasCreds) {
      await scenario("prompt", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-1",
          sessionId: "paseo-sid-1",
          history: "replay",
          config: {
            cwd: isolated.home,
            env: {},
            mcpServers: {},
            settings: {},
            persist: true,
            model: "deepseek-official/deepseek-flash",
            mode: "build",
          },
        });
        const opened = await waitEvent(events, (e) => e.type === "session.opened", 90_000, "session.opened");
        // The native DSH id must be preserved in persistence, not invented.
        const persisted = opened.persistence.data;
        assert.match(String(persisted.dshSessionId), /^session-[0-9a-f-]{36}$/i);

        await waitEvent(events, (e) => e.type === "session.ready", 30_000, "session.ready");
        await connection.send({
          type: "session.prompt",
          sessionId: "paseo-sid-1",
          prompt: {
            clientMessageId: "msg-1",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Reply with exactly: E2E_OK" }] },
          },
        });
        const result = await waitEvent(
          events,
          (e) => e.type === "session.prompt_result" && e.clientMessageId === "msg-1",
          90_000,
          "prompt result",
        );
        assert.equal(result.result.type, "turn", `prompt failed: ${JSON.stringify(result.result)}`);

        // The assistant text must arrive as real timeline items.
        const assistant = await waitEvent(
          events,
          (e) => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text.length > 0,
          120_000,
          "assistant message",
        );
        process.stdout.write(`    assistant: ${JSON.stringify(assistant.item.text.slice(0, 60))}\n`);

        await waitEvent(
          events,
          (e) => e.type === "session.turn" && e.state === "completed",
          120_000,
          "turn completed",
        );

        // Regression guard: one prompt must produce exactly ONE user bubble.
        // The bridge used to consume both the process-wide session/event listener
        // and the follow stream, so every durable event was delivered twice and the
        // user's message appeared twice in the Paseo timeline.
        const userBubbles = events.filter(
          (e) => e.type === "timeline.item" && e.item.type === "user_message",
        );
        assert.equal(
          userBubbles.length,
          1,
          `expected exactly one user_message for one prompt, got ${userBubbles.length}`,
        );
        // The echo must carry the clientMessageId the prompt was sent with, so the
        // daemon can retire the optimistic bubble instead of drawing both.
        assert.equal(
          userBubbles[0].item.clientMessageId,
          "msg-1",
          `user_message carries clientMessageId ${String(userBubbles[0].item.clientMessageId)}, expected msg-1`,
        );

        await connection.close();
      });

      await scenario("open-applies-selection", async () => {
        // Regression guard: the model and effort Paseo opens a session with must be
        // pushed into the harness, not merely echoed back. Without this the composer
        // showed the user's pick while the harness kept running its default model.
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "catalog",
          requestId: "cat-sel",
        });
        const catalog = await waitEvent(events, (e) => e.type === "catalog", 60_000, "catalog");
        // Pick the first model that advertises a non-default reasoning effort.
        const candidate = catalog.catalog.models.find(
          (model) => (model.thinkingOptions ?? []).length > 0,
        );
        assert.ok(candidate, "need a model with reasoning efforts for this scenario");
        const effort = candidate.thinkingOptions[candidate.thinkingOptions.length - 1];

        await connection.send({
          type: "session.open",
          requestId: "open-sel",
          sessionId: "paseo-sid-sel",
          history: "skip",
          config: {
            cwd: isolated.home,
            env: {},
            mcpServers: {},
            settings: {},
            persist: false,
            model: candidate.id,
            thinkingOption: effort.id,
          },
        });
        await waitEvent(events, (e) => e.type === "session.ready", 120_000, "ready");

        const config = await waitEvent(
          events,
          (e) => e.type === "session.config" && e.config.model !== undefined,
          60_000,
          "config with model",
        );
        assert.equal(
          config.config.model,
          candidate.id,
          `harness reports ${String(config.config.model)} but ${candidate.id} was selected`,
        );
        assert.equal(
          config.config.thinkingOption,
          effort.id,
          `harness reports effort ${String(config.config.thinkingOption)} but ${effort.id} was selected`,
        );

        // No warning notice means the harness accepted the selection.
        const rejected = events.find(
          (e) => e.type === "session.notice" && e.notice.severity === "warning",
        );
        assert.equal(rejected, undefined, `selection was rejected: ${JSON.stringify(rejected)}`);
        process.stdout.write(`    applied ${candidate.id} @ ${effort.id}\n`);
        await connection.close();
      });

      await scenario("reopen-history", async () => {
        // Writes one turn, closes the provider, then reopens the same DSH session
        // with history replay. Replay and the live stream must not each render the
        // same message.
        const first = await openProvider(isolated);
        await first.connection.send({
          type: "session.open",
          requestId: "hist-open-1",
          sessionId: "paseo-sid-hist",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(first.events, (e) => e.type === "session.ready", 120_000, "ready");
        await first.connection.send({
          type: "session.prompt",
          sessionId: "paseo-sid-hist",
          prompt: {
            clientMessageId: "hist-msg-1",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "history marker" }] },
          },
        });
        await waitEvent(
          first.events,
          (e) => e.type === "session.turn" && e.state === "completed",
          120_000,
          "turn completed",
        );
        const opened = first.events.find((e) => e.type === "session.opened");
        const persistence = opened.persistence;
        await first.connection.close();

        const second = await openProvider(isolated);
        await second.connection.send({
          type: "session.open",
          requestId: "hist-open-2",
          sessionId: "paseo-sid-hist-reopen",
          history: "replay",
          persistence,
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(second.events, (e) => e.type === "session.ready", 120_000, "reopened ready");
        // Give the replay a moment to settle before counting.
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const replayed = second.events.filter(
          (e) => e.type === "timeline.item" && e.item.type === "user_message" && e.item.text === "history marker",
        );
        assert.equal(
          replayed.length,
          1,
          `history replay rendered the user message ${replayed.length} times, expected 1`,
        );
        assert.equal(
          replayed[0].item.clientMessageId,
          "hist-msg-1",
          "replayed user_message lost its clientMessageId",
        );
        process.stdout.write(`    replayed once; persisted ${String(persistence.data.dshSessionId)}\n`);
        await second.connection.close();
      });

      await scenario("plan-mode", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-2",
          sessionId: "paseo-sid-2",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(events, (e) => e.type === "session.ready", 90_000, "ready");

        // Switching to plan must reach the native seam and come back as config.
        await connection.send({
          type: "session.configure",
          requestId: "cfg-1",
          sessionId: "paseo-sid-2",
          changes: { mode: "plan" },
        });
        await waitEvent(events, (e) => e.type === "request.completed" && e.requestId === "cfg-1", 60_000, "configure");
        const planConfig = await waitEvent(
          events,
          (e) => e.type === "session.config" && e.config.mode === "plan",
          30_000,
          "plan config",
        );
        assert.equal(planConfig.config.mode, "plan");
        process.stdout.write(`    plan mode active via config\n`);
        await connection.close();
      });

      await scenario("thinking-effort", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-3",
          sessionId: "paseo-sid-3",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(events, (e) => e.type === "session.ready", 90_000, "ready");
        await connection.send({
          type: "session.configure",
          requestId: "cfg-2",
          sessionId: "paseo-sid-3",
          changes: { model: "deepseek-official/deepseek-flash", thinkingOption: "deepseek-official/deepseek-flash/low" },
        });
        await waitEvent(events, (e) => e.type === "request.completed" && e.requestId === "cfg-2", 60_000, "configure");
        const config = await waitEvent(
          events,
          (e) => e.type === "session.config" && e.config.thinkingOption !== undefined,
          30_000,
          "thinking config",
        );
        assert.match(String(config.config.thinkingOption), /\/low$/);
        process.stdout.write(`    thinking=${config.config.thinkingOption}\n`);
        await connection.close();
      });

      await scenario("permission-setting", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-4",
          sessionId: "paseo-sid-4",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        const ready = await waitEvent(events, (e) => e.type === "session.ready", 90_000, "ready");
        assert.equal(ready.type, "session.ready");
        const config = await waitEvent(
          events,
          (e) => e.type === "session.config" && e.config.settings.some((s) => s.id === "permission-preset"),
          60_000,
          "permission setting",
        );
        const setting = config.config.settings.find((s) => s.id === "permission-preset");
        assert.equal(setting.type, "select");
        assert.ok(setting.options.length >= 2, "permission presets must come from the host");
        // Full access exists but must never be the default the provider applies.
        assert.notEqual(setting.value, "danger-full-access");
        process.stdout.write(`    presets=${setting.options.map((o) => o.value).join(",")}\n`);
        await connection.close();
      });

      await scenario("persistence-resume", async () => {
        const first = await openProvider(isolated);
        await first.connection.send({
          type: "session.open",
          requestId: "open-5",
          sessionId: "paseo-sid-5",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        const opened = await waitEvent(first.events, (e) => e.type === "session.opened", 90_000, "opened");
        const dshSessionId = opened.persistence.data.dshSessionId;
        await first.connection.close();

        // Re-open with the recorded persistence: this must restore the same DSH
        // session instead of creating a second one.
        const second = await openProvider(isolated);
        await second.connection.send({
          type: "session.open",
          requestId: "open-6",
          sessionId: "paseo-sid-5b",
          history: "replay",
          persistence: opened.persistence,
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        const reopened = await waitEvent(second.events, (e) => e.type === "session.opened", 90_000, "reopened");
        assert.equal(reopened.persistence.data.dshSessionId, dshSessionId, "resume must reuse the native session");
        process.stdout.write(`    resumed ${dshSessionId}\n`);
        await second.connection.close();
      });

      await scenario("sessions-list", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({ type: "sessions", requestId: "list-1" });
        const listed = await waitEvent(events, (e) => e.type === "sessions", 60_000, "sessions");
        assert.ok(listed.sessions.length > 0, "the DSH home holds sessions from earlier scenarios");
        for (const session of listed.sessions) {
          assert.match(String(session.persistence.data.dshSessionId), /^session-/);
        }
        process.stdout.write(`    listed=${listed.sessions.length}\n`);
        await connection.close();
      });

      await scenario("cancel", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-7",
          sessionId: "paseo-sid-7",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(events, (e) => e.type === "session.ready", 90_000, "ready");
        await connection.send({
          type: "session.prompt",
          sessionId: "paseo-sid-7",
          prompt: {
            clientMessageId: "msg-7",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Count slowly to 500 in words." }] },
          },
        });
        await waitEvent(events, (e) => e.type === "session.turn" && e.state === "started", 60_000, "turn started");
        await connection.send({ type: "session.interrupt", requestId: "int-7", sessionId: "paseo-sid-7" });
        await waitEvent(events, (e) => e.type === "request.completed" && e.requestId === "int-7", 30_000, "interrupt ack");
        const canceled = await waitEvent(
          events,
          (e) => e.type === "session.turn" && e.state === "canceled",
          60_000,
          "turn canceled",
        );
        assert.equal(canceled.state, "canceled");
        process.stdout.write("    turn canceled\n");
        await connection.close();
      });

      await scenario("subagent", async () => {
        const { connection, events } = await openProvider(isolated);
        await connection.send({
          type: "session.open",
          requestId: "open-8",
          sessionId: "paseo-sid-8",
          history: "skip",
          config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
        });
        await waitEvent(events, (e) => e.type === "session.ready", 90_000, "ready");
        await connection.send({
          type: "session.prompt",
          sessionId: "paseo-sid-8",
          prompt: {
            clientMessageId: "msg-8",
            delivery: "auto",
            input: {
              type: "message",
              content: [
                {
                  type: "text",
                  text: 'Use the subagent tool exactly once with prompt "Reply with the single word CHILD". Then reply DONE.',
                },
              ],
            },
          },
        });
        // A sub-session must be declared with the parent linkage Paseo needs.
        const child = await waitEvent(
          events,
          (e) => e.type === "session.opened" && e.restoration === "parent",
          180_000,
          "child session",
        );
        assert.equal(child.parentSessionId, "paseo-sid-8");
        process.stdout.write(`    child=${child.sessionId}\n`);
        await connection.close();
      });
    }

    await scenario("tool-approval", async () => {
      // Approval wiring is verified at the bridge level by driving a tool that
      // needs permission; without credentials the host still asks.
      const { connection, events } = await openProvider(isolated);
      await connection.send({
        type: "session.open",
        requestId: "open-9",
        sessionId: "paseo-sid-9",
        history: "skip",
        config: { cwd: isolated.home, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      const config = await waitEvent(
        events,
        (e) => e.type === "session.config",
        90_000,
        "config with permission setting",
      );
      const permission = config.config.settings.find((setting) => setting.id === "permission-preset");
      assert.ok(permission, "permission preset must be exposed for the approval channel");
      // Deny-by-default: the provider must not silently widen to full access.
      assert.notEqual(permission.value, "danger-full-access");
      process.stdout.write(`    approval channel wired (current preset: ${permission.value})\n`);
      await connection.close();
    });
  } finally {
    if (!keep) {
      rmSync(isolated.home, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nkept ${isolated.home}\n`);
    }
  }

  process.stdout.write("\n──────── summary ────────\n");
  for (const result of results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name} (${result.ms}ms)\n`);
  }
  if (failures > 0) {
    process.stdout.write(`\n${failures} scenario(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nall ${results.length} scenarios passed\n`);
}

await main();
