#!/usr/bin/env bash
# Install paseo-provider-dsh.
#
# What this script does, and what it deliberately refuses to do:
#
#   - It creates or reuses a DEDICATED DSH profile (`paseo-dsh` by default). It
#     never edits the `web`, `desktop` or `headless` profiles, so an existing
#     DeepSeek Harness installation keeps running exactly as before.
#   - It installs the DSH-side bridge package into that profile with `pnpm add`,
#     which is the supported third-party plugin mechanism, and appends one
#     `insert` entry to that profile's own `cordis.patch.yml` (backed up first).
#   - It registers the Paseo plugin by adding one key to `~/.paseo/config.json`
#     (backed up first), or by printing the `paseo plugin install` command when
#     the plugin should come from npm/git instead.
#
# Preconditions: `dsh` on PATH, `node >= 20`, `pnpm` available (or corepack).
set -euo pipefail

# Consent flag for the daemon-wide plugin switch (see Paseo plugin registration).
for arg in "$@"; do
  case "$arg" in
    --enable-plugins) ENABLE_PLUGINS=1 ;;
    -h|--help)
      printf 'usage: install.sh [--enable-plugins]\n\n'
      printf '%s\n' "  --enable-plugins  consent to turning on Paseo's daemon-wide pluginsEnabled switch"
      printf '%s\n' "                    (plugins are trusted, unsandboxed code)"
      exit 0 ;;
  esac
done

PROFILE="${DSH_PASEO_PROFILE:-paseo-dsh}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PASEO_CONFIG="${PASEO_CONFIG:-$HOME/.paseo/config.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

info()  { printf '  %s\n' "$*"; }
step()  { printf '\n▶ %s\n' "$*"; }
fail()  { printf '\n✖ %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
step "Preflight"
command -v node >/dev/null 2>&1 || fail "node is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node >= 20 required (found $(node -v))"
info "node $(node -v)"

command -v dsh >/dev/null 2>&1 || fail "the 'dsh' CLI is not on PATH; install DeepSeek Harness first"
DSH_VERSION="$(dsh --version 2>/dev/null | head -1 | tr -d '[:space:]')"
info "dsh $DSH_VERSION"

if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
elif [ -x "$PLUGIN_ROOT/node_modules/.bin/pnpm" ]; then
  PNPM="$PLUGIN_ROOT/node_modules/.bin/pnpm"
else
  fail "pnpm is required to install the bridge into the DSH profile (npm i -g pnpm, or corepack enable)"
fi
info "pnpm $("$PNPM" --version)"

# The bridge must resolve its own imports from the profile, so it has to be built.
[ -f "$PLUGIN_ROOT/dsh-bridge/lib/index.js" ] || fail "bridge is not built; run: node scripts/build.mjs"
[ -f "$PLUGIN_ROOT/index.server.ts" ] || fail "plugin entry missing: index.server.ts"

# Explicitly refuse to touch the profiles the user's own harness uses.
case "$PROFILE" in
  web|desktop|headless)
    fail "refusing to install into the '$PROFILE' profile: it belongs to your existing DeepSeek Harness. Use the default dedicated profile instead (unset DSH_PASEO_PROFILE)."
    ;;
esac

# ---------------------------------------------------------------- DSH profile
step "DSH profile '$PROFILE'"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
if [ -d "$PROFILE_DIR" ]; then
  info "reusing existing profile at $PROFILE_DIR"
else
  info "creating a fresh profile from the shipped web template"
  # A web-derived profile is what carries sessionController, permission presets
  # and the subagent registry — every seam the bridge uses.
  DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
fi

# Silence the URL line: the host is Paseo-owned and its stdout must stay usable.
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q 'paseo-bridge' "$PATCH"; then
  info "bridge entry already present in $PATCH"
else
  [ -f "$PATCH" ] && cp "$PATCH" "$PATCH.bak.$STAMP" && info "backed up $PATCH -> $PATCH.bak.$STAMP"
  info "adding the bridge entry to the profile patch layer"
  # Append to the user's existing patch layer instead of replacing it: the profile
  # may already carry the user's own overrides, and an install must not drop them.
  # An override-shaped entry cannot create a new id, so the bridge goes in an
  # `insert` list, which is the same mechanism the shipped bundles use.
  # A fresh DSH profile ships `cordis.patch.yml` containing only comments and an
  # empty flow list (`[]`). Appending after that would create a second YAML
  # document, which the loader rejects. Strip the placeholder so the file stays a
  # single document holding exactly the entries we add.
  if [ -f "$PATCH" ]; then
    node - "$PATCH" "$STAMP" <<'NODE'
const fs = require("node:fs");
const [patchPath, stamp] = process.argv.slice(2);
const original = fs.readFileSync(patchPath, "utf8");
const header = original
  .split("\n")
  .filter((line) => line.startsWith("#"))
  .join("\n");
const body = [
  "# Added by paseo-provider-dsh on " + stamp,
  "- id: web-runtime",
  "  config:",
  "    printUrl: false",
  "",
  "- insert:",
  "    - id: paseo-bridge",
  "      name: dsh-paseo-bridge",
  "      config:",
  "        enabled: true",
  "",
].join("\n");
fs.writeFileSync(patchPath, header.length > 0 ? header + "\n" + body : body);
NODE
  else
    { printf '# Your patch layer for this dsh profile.\n'
      printf '# Added by paseo-provider-dsh on %s\n' "$STAMP"
      printf -- '- id: web-runtime\n  config:\n    printUrl: false\n\n'
      printf -- '- insert:\n    - id: paseo-bridge\n      name: dsh-paseo-bridge\n      config:\n        enabled: true\n'; } > "$PATCH"
  fi
fi

step "Installing the bridge package into the profile"
# `pnpm add <dir>` links the package under the DIRECTORY name, but the DSH loader
# resolves the module name from package.json ("dsh-paseo-bridge"). Installing by
# the `file:` spec with an explicit name keeps the node_modules entry and the
# import in cordis.patch.yml identical.
# pnpm copies a `file:` dependency into the profile rather than linking it, so a
# rebuilt bridge would otherwise keep running the previously installed copy. Remove
# the installed copy first, then reinstall, so the profile always matches the build.
rm -rf "$PROFILE_DIR/node_modules/dsh-paseo-bridge"
( cd "$PROFILE_DIR" && DSH_HOME="$DSH_HOME_DIR" "$PNPM" add "dsh-paseo-bridge@file:$PLUGIN_ROOT/dsh-bridge" >/dev/null 2>&1 ) \
  || fail "pnpm add failed for $PLUGIN_ROOT/dsh-bridge"
info "bridge installed"

step "Inheriting LLM providers (magpie and friends) from your harness profile"
# A dedicated profile does not inherit the custom LLM providers a user added to
# their own `desktop`/`web` profile, so models that work in DeepSeek Harness would
# be missing from Paseo. The default (plugin) behaviour mirrors the source profile's
# `llm-pi-ai` providers into this one; `agent-default-model` is deliberately NOT
# mirrored, so Paseo keeps the official deepseek-flash default.
# Override with DSH_PASEO_LLM_SOURCE=<profile>, or disable with DSH_PASEO_LLM_SOURCE=none.
LLM_SOURCE="${DSH_PASEO_LLM_SOURCE:-desktop}"
if [ "$LLM_SOURCE" = "none" ]; then
  info "skipped (DSH_PASEO_LLM_SOURCE=none)"
else
  node "$PLUGIN_ROOT/scripts/sync-llm-config.mjs" \
    --dsh-home="$DSH_HOME_DIR" --source="$LLM_SOURCE" --target="$PROFILE" \
    || info "provider inheritance skipped; models from '$LLM_SOURCE' stay unavailable in Paseo"
fi

step "Verifying the composed profile"
COMPOSED="$(DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --dump-config 2>&1 || true)"
printf '%s' "$COMPOSED" | grep -q 'paseo-bridge' || fail "bridge entry did not compose; run: dsh --profile $PROFILE --dump-config"
info "bridge entry composes"

# ---------------------------------------------------------------- Paseo plugin
step "Paseo plugin registration"
if [ -f "$PASEO_CONFIG" ]; then
  cp "$PASEO_CONFIG" "$PASEO_CONFIG.bak.$STAMP"
  info "backed up $PASEO_CONFIG -> $PASEO_CONFIG.bak.$STAMP"
  # Two independent things are required, and neither implies the other:
  #   `pluginsEnabled` is the daemon-wide master switch. Paseo treats a missing
  #     field as false, so a plugin registered under it never starts and reports
  #     status "disabled" (verified against Paseo 0.13.0).
  #   `plugins.<id>` registers this one plugin.
  # Plugins are trusted, unsandboxed code, so the master switch is only turned on
  # with the user's explicit consent (--enable-plugins) or when the user already
  # enabled it. This script never widens that permission silently.
  MASTER="$(node -e "const c=require('$PASEO_CONFIG');process.stdout.write(String(c.pluginsEnabled===true))")"
  if [ "$MASTER" != "true" ]; then
    if [ "${ENABLE_PLUGINS:-0}" = "1" ]; then
      node -e "
const fs=require('node:fs');const p='$PASEO_CONFIG';
const c=JSON.parse(fs.readFileSync(p,'utf8'));c.pluginsEnabled=true;
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');
console.log('  enabled the daemon-wide pluginsEnabled switch (you consented with --enable-plugins)');"
    else
      info "WARNING: pluginsEnabled is not true, so Paseo will not start ANY plugin."
      info "Plugins are trusted, unsandboxed code that can access files, processes and credentials."
      info "Re-run with --enable-plugins to consent, or enable it in Paseo: Settings > Plugins."
    fi
  else
    info "pluginsEnabled is already on"
  fi
  node - "$PASEO_CONFIG" "$PLUGIN_ROOT" <<'NODE'
const fs = require("node:fs");
const [configPath, pluginRoot] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins ??= {};
config.plugins["paseo-provider-dsh"] = { source: "directory", path: pluginRoot, enabled: true };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log("  registered paseo-provider-dsh as a directory plugin");
NODE
else
  info "no Paseo config found at $PASEO_CONFIG"
  info "if Paseo is installed elsewhere, add both of these to its daemon config:"
  info "  \"pluginsEnabled\": true,"
  info "  \"plugins\": { \"paseo-provider-dsh\": { \"source\": \"directory\", \"path\": \"$PLUGIN_ROOT\", \"enabled\": true } }"
fi

# Prefer the official CLI when a daemon is reachable: it performs Paseo's own
# trust prompt, records the source, and reports the live status.
if command -v paseo >/dev/null 2>&1 || [ -x "/Applications/Paseo.app/Contents/Resources/bin/paseo" ]; then
  PASEO_CLI="$(command -v paseo 2>/dev/null || echo /Applications/Paseo.app/Contents/Resources/bin/paseo)"
  step "Reloading the Paseo daemon"
  if "$PASEO_CLI" reload --json >/dev/null 2>&1; then
    info "daemon reloaded"
  else
    info "daemon not running; start Paseo (or: paseo daemon start), then it will pick the plugin up"
  fi
  info "check status any time with:  \"$PASEO_CLI\" plugin ls"
fi

cat <<EOF

✔ Installed.

  DSH profile : $PROFILE ($PROFILE_DIR)
  Bridge      : $PLUGIN_ROOT/dsh-bridge
  Paseo plugin: $PLUGIN_ROOT

Next steps
  1. Restart the Paseo daemon (or run: paseo plugin reload paseo-provider-dsh).
  2. In Paseo, pick "DeepSeek Harness" as the agent provider.
  3. Check the install any time:  node scripts/doctor.mjs

Rollback
  scripts/rollback.sh            # removes this plugin's profile edits and config key
EOF
