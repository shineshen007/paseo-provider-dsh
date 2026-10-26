# CURRENT_STATE

updated_at: 2026-10-26
current_goal: deliver a native Paseo provider plugin for DeepSeek Harness (paseo-provider-dsh)

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
