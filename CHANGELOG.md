# Changelog

## 0.1.0

First working release.

### Added
- Native Paseo provider for DeepSeek Harness via `@getpaseo/plugin/server/provider` (no ACP).
- `dsh-bridge`: DSH-side bridge plugin exposing session controller, approvals, questions, permission
  presets, commands, subagents and durable events over a private JSON-RPC channel.
- Unix-socket transport with reconnect recovery (host outlives a daemon restart).
- Native plan mode via the `/plan` command seam + `plan` projection.
- Real model catalogue and reasoning-effort switching.
- Sandbox/approval presets as a Paseo setting; full access never auto-selected.
- Tool approvals and interactive questions through DSH's waterfalls.
- Sub-agents mapped to Paseo sub-sessions with parent/tool-call linkage.
- Durable session id preserved in `ProviderPersistence`; history replay via `follow`/`page`.
- Cancellation, persistence, session listing, rename, fork, attachments.
- `build.mjs`, `install.sh`, `uninstall.sh`, `rollback.sh`, `doctor.mjs`, real-DSH e2e suite.
- 28 contract tests validated against the Paseo SDK's own zod schemas.

### Known limits
See `docs/LIMITATIONS.md`.
