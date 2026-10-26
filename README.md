# paseo-provider-dsh

A **native** [Paseo](https://paseo.sh) provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It registers a first-class Paseo provider through `@getpaseo/plugin/server/provider` and drives a real
`dsh` host through that provider's own contract. There is **no ACP process, no `runAcpProvider`, and
no ACP translation layer** anywhere in this project.

```
Paseo daemon ──► paseo-provider-dsh (this repo, server/) ──► [unix socket JSON-RPC]
                                                                    │
                                                                    ▼
                                          dsh-paseo-bridge (in a dedicated dsh profile host)
                                                                    │
                                                                    ▼
                                       ctx.sessionController · ctx.approval · ctx.commands
                                       ctx.permissionPresets · ctx.userQuestions · ctx.subagents
```

## What it does

| Capability | How it stays native |
|---|---|
| **Plan mode** | Toggles DeepSeek Harness's own plan mode through its `/plan` command seam and reads the durable `plan/mode` state back |
| **Model + thinking effort** | Both come from `ctx.sessionController.modelCatalog()`; effort ids are the host's real `reasoningEfforts` (`off/low/high/max`) |
| **Sandbox / permission presets** | Exposed as a Paseo setting backed by `ctx.permissionPresets` (`read-only`, `workspace-write`, …); full access is never selected automatically |
| **Tool approvals** | Real `approval/request` waterfall answers; the closed DSH outcome vocabulary (`allowed-once` / `rejected` / `cancelled`) is preserved |
| **Interactive questions** | Real `user-questions/request` waterfall answers |
| **Sub-agents** | Child sessions become Paseo sub-sessions with parent linkage and the spawning tool call id |
| **Native session ids** | The DSH `session-<uuid>` is persisted in `ProviderPersistence` and restored verbatim — Paseo never invents a durable DSH id |
| **Streaming** | Process-local assistant deltas from `follow({assistantStream:true})` become timeline deltas sharing one `messageId` |
| **History / replay / resume** | Read through DSH's official `page` / `follow` / `projections` surface; the compressed on-disk log is never parsed |
| **Cancellation** | `session/interrupt` → `ctx.sessionController.cancel`, with the real turn state reported back |

## Install

```bash
node scripts/build.mjs      # build the plugin + bridge
bash scripts/install.sh     # dedicated DSH profile + Paseo plugin registration
node scripts/doctor.mjs     # verify every boundary (12 checks)
```

Then restart the Paseo daemon and pick **DeepSeek Harness** as the provider.

`install.sh` never touches your existing `web`, `desktop` or `headless` DSH profiles, and only adds one
key to the Paseo daemon config (backing it up first). See [docs/INSTALL.md](docs/INSTALL.md).

## Requirements

- Paseo **0.13.x** (manifest requires `>=0.13.0 <0.14.0`)
- `@deepseek-ai/dsh` CLI on `PATH` (developed against `0.2.1-rc.2`)
- Node ≥ 20, `pnpm` for the profile install
- macOS, Ubuntu, or a Paseo Remote SSH host (the daemon and the `dsh` child run on the same machine)

## Verify

```bash
npm test                        # 28 contract tests (pure mapping + Paseo SDK zod schemas)
node scripts/e2e/run.mjs        # 10 scenarios against a real dsh host
```

The integration suite creates an isolated `DSH_HOME` under a temp directory, so it never reads or
writes real harness state. Results are recorded in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Uninstall / rollback

```bash
bash scripts/uninstall.sh        # inverse of install; keeps your sessions
bash scripts/rollback.sh --list  # show pre-install backups
bash scripts/rollback.sh --restore <backup>
```

Harness sessions and history survive an uninstall: they are still readable in DeepSeek Harness.

## 中文文档

完整的中文安装与使用说明见 [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)，包含插件总开关、
逐步安装、功能对照表、远程 SSH、卸载回滚与排错。

## Known limits

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the honest list, including file-level revert,
per-session MCP injection, archiving, and attaching to an already-running harness host.

## Layout

```
index.server.ts      Paseo plugin entry (registers the provider)
server/              provider contract, host lifecycle, RPC client, mapping glue
shared/              wire contract + pure DSH→Paseo mapping (shared by both halves)
dsh-bridge/          the DSH-side bridge plugin (separately installable package)
scripts/             build, install, uninstall, rollback, doctor, e2e
test/                contract tests
docs/                architecture, findings, install, acceptance, limitations
```

## License

MIT — see [LICENSE](LICENSE).

## 相关项目

- [Paseo](https://github.com/getpaseo/paseo) — 本插件所扩展的宿主
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 本插件驱动的运行时
