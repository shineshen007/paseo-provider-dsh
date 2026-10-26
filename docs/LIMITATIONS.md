# Limitations

Everything below is a known gap with its reason. Nothing here is presented to the Paseo UI as if it
worked: the provider refuses or degrades explicitly rather than showing fabricated state.

## Not implemented (and refused explicitly)

| Item | Why | Behaviour |
|---|---|---|
| **File-level revert** (`session.revert.files`) | DSH has no file-rollback seam; only conversation forking exists | `session.revert` with `scope: "files"` returns `request.failed{code:"dsh/unsupported"}` instead of silently doing nothing |
| **Session archive / unarchive** | DSH has no native archive flag for this composition | `session.archive` / `unarchive` return `request.failed`, so Paseo never claims a state DSH does not hold |
| **Per-session MCP injection** (`mcpServers`) | DSH binds MCP servers at profile composition, not per session | The field is accepted and ignored; a session cannot gain a server the profile lacks. Documented rather than faked |
| **`prompt.output_schema`** | No structured-output seam on the DSH main agent | Capability not advertised |
| **Prompt images** | The bridge accepts images (`PromptContentPart{type:"image"}`), but the Paseo capability `prompt.image` is not advertised yet because DSH's image admission path was not verified end-to-end in this pass | Prompt text works; images are currently dropped by the Paseo side because the capability is not offered |
| **Windows** | Out of scope per the task (macOS / Ubuntu / Remote SSH) | Unix socket + POSIX `flock` assumptions; would need a named-pipe carrier |

## Partial / with caveats

| Item | Caveat |
|---|---|
| **Attaching to an already-running harness host** | The provider always spawns its **own** dedicated `dsh` host. Attaching to the user's live Web/Desktop host would require installing the bridge into that production profile and reusing its private gateway auth — deliberately avoided to honour "do not overwrite production config". Consequence: a session currently owned by the desktop app reports DSH's `session/writer-held`; the provider surfaces it as an error rather than stealing the lock |
| **Sub-agent history replay** | Child sessions opened after a Paseo reconnect are re-declared from `subagents.listChildren`, but a sub-session's *full* past timeline is only replayed for the parent. Deep child history requires an extra `page` per child |
| **Plan-mode pending state** | When a plan toggle lands mid-turn, DSH queues it (`outcome: "queued"`); Paseo shows the committed state, and the queued transition appears when DSH commits it |
| **Tool cards for unknown tools** | Rendered as `unknown` with the real input/output payload rather than a guessed presentation |
| **`session.revert` conversation scope** | Implemented as a DSH fork; Paseo shows a notice with the new session id, but does not automatically switch the open conversation to the fork |
| **Usage / cost** | `session.usage` is not emitted: the DSH token meter was not wired to Paseo's usage event in this pass. The projection `tokenUsage` is present in the host and is the intended source |

## Operational limits

| Limit | Detail |
|---|---|
| **One host per provider connection** | Each `connect()` spawns a `dsh` host. Many simultaneous Paseo workspaces mean several hosts; each holds its own memory footprint (DSH is a full harness) |
| **Socket path length** | `sun_path` is 104 bytes on macOS; `resolveSocketPath` falls back to the temp dir, and fails loudly if even that does not fit |
| **Unary Remote calls need an `AbortSignal`** | Several DSH methods throw on `undefined`; the bridge always supplies one. This is an undocumented DSH pre-condition, so a future DSH may change it |
| **`page` cut bound** | `throughSeq` must not exceed the live follow cursor; the bridge clamps it. History deeper than one page requires repeated `page` calls with `beforeSeq` |
| **Startup cost** | First `connect()` waits for a full harness boot (observed ~2–4 s warm, longer cold). `status()` is cheap and does not boot a host |
| **Bridge feature probing** | Features are declared statically by this build; a DSH that drops a service makes the related call fail at use time rather than at handshake |

## Verification gaps in this pass

| Gap | Impact |
|---|---|
| **Human-answered approval round trip** | The e2e asserts the approval channel is wired and that full access is not auto-selected, but no scenario drives a model into requesting a tool approval and then answers it from the Paseo UI. The waterfall mapping itself is exercised in unit tests |
| **Ubuntu run** | Verified by construction (POSIX socket, no platform branches) but not executed on Ubuntu in this environment |
| **Remote SSH run** | Same: design supports it, not executed end-to-end here |
| **Paseo UI rendering** | The provider is driven through the exact `ProviderConnection` surface the daemon uses, and every emitted value is validated against Paseo's own zod schemas, but no screenshot-level UI verification was performed inside the Paseo app |
