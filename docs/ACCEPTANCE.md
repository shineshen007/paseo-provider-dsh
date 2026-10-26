# Acceptance report

Environment: macOS arm64, Node v24.15.0, `@deepseek-ai/dsh` 0.2.1-rc.2,
Paseo app 0.13.0 / `@getpaseo/plugin` 0.13.1.

Commands:

```bash
node scripts/build.mjs        # build
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
node scripts/e2e/run.mjs
node scripts/doctor.mjs
```

## Results

| Suite | Result |
|---|---|
| Build | pass |
| TypeScript strict (`noEmit`) | pass, 0 errors |
| Unit / contract tests | **28/28 pass** |
| Real-DSH integration suite | **10/10 pass** |
| `doctor` (isolated install) | **12 ok, 0 warnings, 0 failures** |
| Install → doctor → uninstall round-trip | pass, config and patch restored byte-for-byte |

## Requirement-by-requirement

### 1. Native provider registration, no ACP ✅

`index.server.ts` calls `server.registerProvider(createDshProvider())`. Verified:

- `grep` over all sources finds no `runAcpProvider`, no `AgentSideConnection`/`ClientSideConnection`,
  no ACP imports (the only matches for "ACP" are the comments asserting its absence, plus Paseo's own
  transitive `@agentclientprotocol/sdk` in `package-lock.json`).
- Paseo's runtime validation rules were read out of the installed app bundle and are all satisfied
  (`id` matches `^[a-z][a-z0-9._-]*$`, non-empty `label`, `connect()` function, `status()` function,
  non-empty `command` parts).
- The provider is exercised through the same `ProviderConnection` surface the daemon uses, in the e2e
  suite.

### 2. Reuse of official DSH SDK / Session Controller / Cordis services ✅

The bridge uses public host services only, confirmed by a live probe in `docs/FINDINGS.md`:

```
sessionController: create, prompt, cancel, selectModel, modelCatalog, list, page, follow,
                   projections, resolveAgent, rename, fork, attachment, inspect
approval.request · permissionPresets.catalog/current/set · userQuestions · subagents.listChildren
commands.list/execute · sessionProjections
```

No DSH package was modified. The profile is composed from shipped bundles plus one `insert` entry.

### 3. Plan mode, model + thinking switching, sandbox permissions, approvals, questions ✅

| Feature | Evidence |
|---|---|
| Plan mode | e2e `plan-mode` passes: Paseo `mode: "plan"` reaches DSH's `/plan` seam and comes back as `session.config{modes}` + durable `plan/mode`. |
| Model switching | e2e `catalog` + `thinking-effort`: models come from `modelCatalog()` (2 providers × 2 models). |
| Thinking effort | e2e `thinking-effort` passes: `thinkingOption` maps to the host's `reasoningEffort`; the round trip reports `/low`. |
| Sandbox / approval presets | e2e `permission-setting` + `tool-approval`: presets come from `ctx.permissionPresets` (`read-only`, `workspace-write`, `danger-full-access`); the test asserts full access is **not** applied. |
| Tool approvals | `approval/request` waterfall answered through `permission/answer`; the e2e asserts the approval channel is wired and the preset is not widened. |
| Interactive questions | `user-questions/request` → `session.permission{kind:"question"}` with the host's real option list. |

No mode, event or result is synthesized: every mapping function returns `null`/`[]` when DSH cannot
justify a value (`shared/mapping.ts`).

### 4. Sub-agent mapping ✅

e2e `subagent` passes: a real delegation produces `session.opened{restoration:"parent",
parentSessionId, toolCallId}`, the child's events are routed into that sub-session, the parent's tool
card is updated in place, and `subagent.finished` closes the card with the child's final text.
Directory-level listing uses `subagents.listChildren` / `listDescendants`.

### 5. Native session id, streaming, persistence, replay, recovery, cancel ✅

| Aspect | Evidence |
|---|---|
| Native id preserved | e2e `persistence-resume`: the reopened session reports the **same** `session-<uuid>`; asserted with a regex and an equality check. |
| Streaming | P0 measured 311 `assistant-stream` frames per turn (`start`/`chunk`/`end`); deltas become timeline items sharing one `messageId`. |
| Persistence | `session.persistence` emitted at every turn end with the durable DSH id, cwd and last seq. |
| History replay | Via `follow` cursor → `page` (never by parsing the compressed on-disk log); e2e reopens with `history: "replay"`. |
| Disconnect recovery | The host outlives the daemon and re-attaches over the socket; the opening snapshot's cursor is the replay watermark. |
| Cancel | e2e `cancel` passes: `session.interrupt` → `ctx.sessionController.cancel` → `session.turn{canceled}`. |

### 6. Platform + non-interference ✅

| Aspect | Evidence |
|---|---|
| macOS | full suite run here |
| Ubuntu | no platform-specific code paths; socket + `flock` are POSIX; `sun_path` budget handles both limits |
| Remote SSH | daemon-local child process + Unix socket, so no port forwarding; `launch` override accepted for a non-standard `dsh` path |
| Existing DSH Web/CLI untouched | install targets a dedicated profile and refuses `web`/`desktop`/`headless`; e2e and `doctor` use a temp `DSH_HOME` |
| Existing sessions untouched | uninstall never deletes sessions; provider only resumes sessions it is asked to open |
| No automatic Full Access | asserted in `permission-setting` and `tool-approval` scenarios |

## What changed in the user's environment during development

Nothing outside this repository. All DSH work used `DSH_HOME=/tmp/...` or a temp dir, and all Paseo
config work used `PASEO_CONFIG=/tmp/...`. The real `~/.dsh` profiles and `~/.paseo/config.json` were
read (for verification) but never written.

## Reproduce

```bash
cd paseo-provider-dsh
npm install && node scripts/build.mjs
./node_modules/.bin/vitest run
node scripts/e2e/run.mjs
```

The e2e suite seeds model credentials from `~/.dsh/.credentials.yaml` into its temp home **without
printing them**; without credentials it still runs the non-model scenarios and reports that model
scenarios were skipped.
