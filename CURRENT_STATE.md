# CURRENT_STATE

updated_at: 2026-10-26
current_goal: deliver a native Paseo provider plugin for DeepSeek Harness (paseo-provider-dsh)

## published
- Push auth: `git config --global credential.helper osxkeychain`, so no token is
  needed for future pushes from this machine.
- GitHub: https://github.com/shineshen007/paseo-provider-dsh (public, branch `main`)
- Commit `feat: native Paseo provider for DeepSeek Harness` — 51 files, 1.11 MB.
- Verified after publish: anonymous clone works, fresh clone installs and passes
  typecheck + 34 contract tests.

## completed
- API feasibility验证 (`docs/FINDINGS.md`), all 10 P0 probes measured against installed DSH + Paseo.
- Two-package implementation: Paseo provider (`server/`, `index.server.ts`) + DSH bridge (`dsh-bridge/`).
- Shared wire contract (`shared/wire.ts`) and Paseo-side mapping (`server/mapping.ts`).
- Unix-socket JSON-RPC transport both ways, with reconnect and feature negotiation.
- All six functional areas wired: catalog/models/thinking, plan mode, permissions/approvals,
  questions, sub-agents, session persistence/replay/cancel.
- Tooling: build, install, uninstall, rollback, doctor, e2e harness.
- Docs: README, ARCHITECTURE, INSTALL, FINDINGS, ACCEPTANCE, LIMITATIONS.

## in_progress
- (none)



## fixed_duplicate-user-bubble
- Symptom: two identical user bubbles in the Paseo UI for one send, while
  `paseo logs` showed one `[User]` line - so the duplicate was UI-level, not a
  provider double-emit (that was the earlier fixed_after_user_field_test defect).
- Cause: the daemon paints an optimistic bubble on send and, on turn acceptance,
  drops the staged echo whose `item.clientMessageId` matches the prompt. Our
  `user_message` timeline item omitted that field, so the lookup missed and both
  bubbles rendered.
- Fix: map DSH `source.rpcId` to `clientMessageId` and DSH `data.id` to
  `messageId`. Observed shape is `{"kind":"user","rpcId":"…"}` - the kind is
  normalized while the correlation id survives, so it must not be gated on
  `kind === "user-rpc"`.
- Also: `onSessionEvent` now skips events at or below a render watermark
  (`appliedSeq`, initialised to -1 because DSH's first sequence is 0), and history
  replay shares that watermark, making page/follow overlap order-independent.
- Also: replay no longer cuts at `persistence.lastSeq`. That watermark is captured
  at session open, before any turn exists, so it truncated replay to nothing.
  `session/page` now omits `throughSeq` and the bridge clamps to its live cursor.

## fixed_after_user_field_test
- Model selection was never pushed into DSH: `session.open.config.model` /
  `thinkingOption` were echoed back but `session/selectModel` was never called, so the
  composer showed the user's pick while the harness ran `agent-default-model`.
  `applyInitialSelection()` now pushes model + effort + mode + permission preset on
  open, and reports a notice instead of failing silently.
- Every durable event was delivered twice: the bridge both listened on the
  process-wide `session/event` and consumed the per-session `follow()` stream. The
  `follow()` iterator is now carried forward explicitly (a `follow()` generator cannot
  be re-iterated) and the global listener only feeds the tool-argument cache.
- `publishConfig` now adopts the harness-persisted model selection, so a resumed
  session shows the model DSH actually holds instead of a blank field.
- `pnpm add file:` COPIES a package into a profile instead of linking it, so a rebuilt
  bridge kept running the previously installed copy and fixes appeared to do nothing.
  `scripts/sync-bridge.mjs` refreshes the installed copy; `install.sh` reinstalls it.
- Regression guards: e2e `open-applies-selection` and a one-user-bubble assertion.

## verified_dsh_side
- Restoring the field-test session from DSH's persisted projection reports
  `ninfer/qwen3.8-27b` at effort `xhigh`: the selection really reached the harness.

## verified_on_real_paseo_daemon
- Paseo 0.13.0 daemon 实测：`plugin ls` → `running`；daemon 日志确认
  `"providers":[{"id":"dsh",...,"hasStatus":true}]`。
- `paseo run "Reply with exactly: PASEO_NATIVE_OK" --provider dsh` 端到端成功，
  回复 `PASEO_NATIVE_OK`，`provider` 字段显示 `dsh/deepseek-official/deepseek-flash`。

## key_decisions
- Bridge plugin inside a dedicated DSH profile instead of ACP or the narrow stdio SDK.
- Unix socket instead of stdio: DSH logs to stdout (measured).
- Plan mode driven through `/plan` + `plan` projection: `ctx.planMode` is agent-preset-scoped, not a
  root service.
- Paseo-side id and DSH native id kept distinct; only the DSH id is durable.
- `danger-full-access` never auto-selected; unsupported features refused with explicit errors.

## changed_files
index.server.ts · server/{provider,host,rpc-client,mapping,ids}.ts · shared/wire.ts ·
dsh-bridge/src/wire.ts (协议副本) ·
dsh-bridge/{package.json,cordis.patch.yml,src/{index,supervisor,rpc,socket,dsh}.ts} ·
scripts/{build.mjs,install.sh,uninstall.sh,rollback.sh,doctor.mjs,e2e/run.mjs} · test/mapping.test.ts ·
docs/{FINDINGS,ARCHITECTURE,INSTALL,ACCEPTANCE,LIMITATIONS,USAGE.zh-CN}.md

## latest_outputs
- `node scripts/build.mjs` → dist/index.server.js, dist/bundle/provider.mjs, dsh-bridge/lib/index.js
- `vitest run` → 28/28 pass
- `node scripts/e2e/run.mjs` → 10/10 scenarios pass against a real dsh host
- `node scripts/doctor.mjs` (isolated install) → 12 ok, 0 warnings, 0 failures

## fixed_during_zh_docs
- `pluginsEnabled` 缺失时插件永不启动（Paseo 视为 false）：install.sh 增加 `--enable-plugins`
  显式同意流程，doctor 增加该检查。
- `shared/` 不得导入 `@getpaseo/plugin/server/*` 或 `node:`：Paseo 自编译插件时拒绝。
  已把映射与 ids 移到 `server/`，`shared/` 只留纯协议，bridge 自带一份协议副本，
  build 时校验两份一致。
- `pnpm add <dir>` 会按**目录名**建链，而 DSH 按**包名**解析：改为按包名安装。
- `connect()` 同步等待 host 启动会触发 daemon 超时：改为懒启动（首个输入才启动宿主）。

## blockers_or_warnings
- No human-answered approval round trip in the e2e suite (channel wiring is asserted instead).
- `prompt.image` not advertised yet; images dropped.
- `session.usage` not emitted yet.
- Ubuntu and Remote SSH verified by construction only, not executed end-to-end here.

## next_step
Add an e2e scenario that drives a model into requesting a tool approval and answers it from the
provider side (`session.permission`), then wire `session.usage` from the `tokenUsage` projection.
