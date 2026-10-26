# Architecture

## Why two packages

The project spans two independently released products, so it is split at the boundary between them:

| Package | Runs inside | Owns |
|---|---|---|
| `paseo-provider-dsh` (this repo root) | The Paseo daemon's plugin subprocess | Everything Paseo-shaped: the provider contract, capability negotiation, timeline items, tool-card details, turn bookkeeping, permission rendering |
| `dsh-paseo-bridge` (`dsh-bridge/`) | A dedicated `dsh` profile host | Everything DSH-shaped: calling `ctx.sessionController`, `ctx.approval`, `ctx.commands`, `ctx.permissionPresets`, `ctx.userQuestions`, `ctx.subagents`, and forwarding durable events |

Either side can be upgraded alone as long as the wire version matches. A DSH upgrade only needs
`dsh-bridge/` re-verified; a Paseo upgrade only needs `server/`.

## Why a bridge at all

The DSH distribution ships two out-of-process surfaces, and neither can express this provider:

1. **`@deepseek-ai/dsh-sdk-protocol` (stdio JSON-RPC)** exposes only `initialize`, `session/prompt`,
   `session/resume`, `session/wait`, `session/working-directory/*`, `shutdown`, plus four
   notifications. It has **no** model switching, plan mode, approvals, questions, cancellation,
   session listing, or history — i.e. none of requirements 3–6. Verified in
   `docs/FINDINGS.md` §P0-4.
2. **The Typert WebSocket gateway** is the browser UI's private transport. Driving it from outside
   would mean reimplementing browser authentication, peer admission, cookies and the generated
   remote codec — fragile, and it would still compete with the user's live UI for the same host.

The DSH-side bridge plugin is therefore the minimal seam the task permits ("必要时开发最小 DSH 侧
IPC 插件"). It follows the same architecture as DSH's own `@deepseek-ai/dsh-acp` plugin — an ordinary
Cordis plugin that uses public host services — but speaks a Paseo-owned protocol instead of ACP.

## Transport: a Unix socket, not stdio

DSH's own SDK server uses stdin/stdout. This provider deliberately does not, for a measured reason:

> A P0 run showed the host writing non-protocol lines to **stdout** (`dsh web: opening the default
> browser…`, `[llm-deepseek-account] model listing …`). Suppressing every host logger to protect a
> protocol channel would mean changing DSH's behaviour, which this project refuses to do.

A Unix-domain socket fixes that and adds two capabilities the requirements ask for:

- **Disconnect recovery.** The `dsh` host outlives a Paseo daemon restart; the plugin reattaches and
  resumes from the durable cursor instead of losing the turn.
- **No networking assumptions.** No TCP port is opened, so a Paseo Remote SSH host needs no
  forwarding, and file permissions (0700 directory, 0600 socket) are the whole access-control story.

Path length is bounded explicitly: `sockaddr_un.sun_path` is 104 bytes on macOS/BSD and 108 on Linux,
so `resolveSocketPath` picks the first candidate that fits (DSH home, then the OS temp dir) and fails
loudly rather than truncating a path.

## The channel

Newline-delimited JSON-RPC 2.0. Two independent implementations (`dsh-bridge/src/rpc.ts` server,
`server/rpc-client.ts` client) rather than one shared module, because the two halves ship separately.

Protocol invariants:

- **Versioned handshake first.** `bridge/initialize` reports `wireVersion`, the negotiated feature
  set, the DSH version and the bridge version. A mismatch fails at connect time with an actionable
  message instead of misbehaving mid-turn.
- **Feature flags gate behaviour.** A newer plugin refuses to claim a Paseo capability whose bridge
  feature is absent, so an old bridge degrades instead of failing deep inside a turn.
- **Requests are concurrent.** Cancel and approval answers must not queue behind a slow prompt.
- **Notifications are contained.** A handler failure never kills a live turn.

## Identity

Paseo and DSH each mint ids, and confusing them would corrupt history.

| Concept | Authority |
|---|---|
| Paseo `sessionId` | Paseo mints it; the provider echoes it in `session.opened` |
| DSH `session-<uuid>` | DSH mints it; stored in `ProviderPersistence.data.dshSessionId` |
| Timeline ids | Derived deterministically (`dsh:<session>:tool:<callId>`), so a restart upserts instead of duplicating |
| Assistant `messageId` | The DSH attempt id — one logical message, many delta items |

Restore always goes through `session/resume` with the persisted native id. The provider never forks a
user's existing session behind their back.

## Turn lifecycle

DSH reports turns durably (`turn/start`, `turn/end`), so the provider reports them from that source
rather than from prompt bookkeeping:

```
prompt → session/prompt RPC → prompt_result{turn} → session.turn{started}
      → durable events (user/message, assistant/message, tool/call, tool/result …)
      → turn/end → session.turn{completed|failed|canceled} + session.persistence
```

`session.integration` of the "cancel → `canceled`" path is covered by the e2e `cancel` scenario.

## Failure discipline

Mirrors Paseo's own ACP adapter so the daemon renders errors the same way:

| Failure | Event |
|---|---|
| A prompt is refused | `session.prompt_result{failed}` |
| A request-shaped input fails | `request.failed` |
| A session-scoped failure | `session.runtime_failed` |

Host-start failures carry the captured `dsh` stderr as `diagnostic`, which is what makes a broken
install diagnosable from the Paseo UI.

## Isolation guarantees

- `install.sh` refuses to target `web`, `desktop` or `headless`, and creates/reuses a dedicated
  `paseo-dsh` profile.
- Only that profile's own `cordis.patch.yml` is edited, after a timestamped backup; the rest of the
  user's patch layer is preserved.
- Only one key is added to the Paseo daemon config, after a backup.
- The e2e suite and `doctor` run against a temp `DSH_HOME`, never the real one.
- `danger-full-access` is reachable only by an explicit user choice in Paseo; nothing in this project
  selects it.
