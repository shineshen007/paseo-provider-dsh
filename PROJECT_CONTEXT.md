# PROJECT_CONTEXT — paseo-provider-dsh

## Goal

A native Paseo provider plugin that drives DeepSeek Harness (`dsh`) directly, with no ACP layer, while
preserving DSH's own capabilities and session identity.

## Stable background

- **Paseo** exposes third-party providers through `@getpaseo/plugin/server/provider`
  (`registerProvider`, provider protocol v1). Paseo loads a plugin's `index.server.ts` inside a daemon
  subprocess.
- **DeepSeek Harness** is a Cordis-based harness. Its rich capability surface is in-process Cordis
  services (`ctx.sessionController`, `ctx.approval`, `ctx.commands`, `ctx.permissionPresets`,
  `ctx.userQuestions`, `ctx.subagents`). Its out-of-process SDK (stdio JSON-RPC) is far narrower and
  cannot express models/plan/approvals/cancel/history.
- DSH profiles are composed from bundle patches under `$DSH_HOME/profiles/<name>/`; third-party
  plugins install with `pnpm add` into a profile and are added to that profile's `cordis.patch.yml`
  through an `insert:` list (a bare `- id:` entry can only *override* an existing entry).

## Architecture (stable)

Two packages, one wire contract:

1. `paseo-provider-dsh` (this repo root, `server/`) — the Paseo half. Owns the provider contract,
   capability negotiation, timeline mapping and every Paseo-shaped decision.
2. `dsh-paseo-bridge` (`dsh-bridge/`) — the DSH half. An ordinary Cordis plugin installed into a
   dedicated profile, calling public host services and forwarding durable events.
3. `shared/` — the wire contract and the pure DSH→Paseo mapping, used by both.

Transport: newline-delimited JSON-RPC 2.0 over a **Unix socket** (not stdio, because the host writes
non-protocol lines to stdout).

## Long-term constraints

- Never modify DSH core or Paseo core.
- Never install into the user's `web`/`desktop`/`headless` DSH profiles.
- Never select `danger-full-access` automatically.
- Never fork or overwrite a user's existing session.
- The DSH `session-<uuid>` is authoritative and must be preserved across restores.
- No fake modes, simulated events, or prompt-engineered substitutes for real capabilities.
