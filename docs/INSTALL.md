# Install, upgrade, uninstall, rollback

## Prerequisites

| Requirement | Check |
|---|---|
| Paseo 0.13.x | `node scripts/doctor.mjs` reports the app version |
| DeepSeek Harness CLI | `dsh --version` |
| Node ≥ 20 | `node -v` |
| pnpm | `pnpm --version` (or let install.sh use the vendored copy) |

## Install

```bash
cd paseo-provider-dsh
npm install                     # dev dependencies (esbuild, typescript, vitest)
node scripts/build.mjs          # builds the plugin bundle and the bridge
bash scripts/install.sh         # dedicated profile + plugin registration
node scripts/doctor.mjs         # 12 checks incl. a live handshake
```

What `install.sh` changes, and nothing else:

1. `$DSH_HOME/profiles/paseo-dsh/` — created from the shipped `web` template when absent.
2. `…/paseo-dsh/cordis.patch.yml` — backed up, then gets the bridge entry plus `printUrl: false`.
3. `…/paseo-dsh/package.json` — the `dsh-paseo-bridge` dependency (via `pnpm add`).
4. `~/.paseo/config.json` — backed up, then one `plugins.paseo-provider-dsh` key.

It **refuses** to target `web`, `desktop` or `headless`.

### Where did `printUrl: false` come from?

The host shares a process with loggers that write to stdout. The bridge does not use stdout (it uses a
socket), but silencing the URL banner keeps the host's stdout clean for anyone reading it, and cannot
affect the user's own harness because it applies only to this dedicated profile.

## Inherited LLM providers

A dedicated profile does not inherit the custom LLM providers a user added to their own
`desktop`/`web` profile, so those models work in DeepSeek Harness but are missing from Paseo.
`install.sh` mirrors the source profile's `llm-pi-ai` providers automatically:

```bash
node scripts/sync-llm-config.mjs --source=desktop --target=paseo-dsh   # manual
DSH_PASEO_LLM_SOURCE=web bash scripts/install.sh                      # other source
DSH_PASEO_LLM_SOURCE=none bash scripts/install.sh                     # opt out
```

Only `llm-pi-ai.config.providers` is mirrored. `agent-default-model` is deliberately **not**
mirrored, so Paseo keeps the harness default (`deepseek-official/deepseek-flash`) even when the
source profile defaults to a third-party provider.

## Upgrade

```bash
git pull
node scripts/build.mjs
bash scripts/install.sh          # idempotent: reuses the profile, keeps one patch entry
```

The install script is safe to re-run: an existing bridge entry is detected and left alone, and the
plugin config key is not duplicated.

## Version compatibility

| Boundary | Enforced by |
|---|---|
| Paseo ↔ plugin | `paseo-plugin.json` `requirements.paseo` (`>=0.13.0 <0.14.0`) + `status()` probe |
| Plugin ↔ bridge | `bridge/initialize` `wireVersion` + feature flags |
| Bridge ↔ DSH | the profile's own `@deepseek-ai/dsh-*` packages; `doctor` reports the resolved bridge and a live handshake |

When DSH changes a service the bridge depends on, the plugin still loads and reports the missing
seam as a feature flag rather than failing: each bridge feature is probed, not assumed.

## Uninstall

```bash
bash scripts/uninstall.sh                 # restore config + patch, remove the bridge
bash scripts/uninstall.sh --purge-profile # also delete the dedicated profile directory
```

Harness **sessions are never deleted**. History created through Paseo stays readable in DeepSeek
Harness, which is the point of preserving the native session id.

## Rollback

```bash
bash scripts/rollback.sh --list              # timestamped backups from install.sh
bash scripts/rollback.sh --restore <backup>  # restore one file
bash scripts/rollback.sh                     # undo the whole install
```

Every edited file was copied before it changed, so rollback is exact rather than reconstructed.

## Remote SSH host

Paseo Remote SSH runs the daemon on the remote machine. Because the provider spawns `dsh` as a **local
child of the daemon** and talks over a **Unix socket**, nothing needs forwarding:

1. Install DeepSeek Harness on the remote host.
2. Run `scripts/install.sh` there.
3. If `dsh` is not on the daemon's `PATH`, set a launch command for the provider in Paseo (it is
   passed through as `request.launch`).

## Troubleshooting

| Symptom | Action |
|---|---|
| Provider shows unavailable | `node scripts/doctor.mjs` — it prints the exact failing boundary |
| First session fails with `host-start` | the diagnostic carries captured `dsh` stderr |
| `bridge entry did not compose` | re-run `install.sh`; it rewrites the patch as a single YAML document |
| `socket path is too long` | set a shorter `DSH_HOME`; the provider falls back to the temp dir automatically |
| Sessions open read-only | another host (e.g. the desktop app) currently owns that session's write lock |
