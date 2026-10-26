#!/usr/bin/env bash
# Remove paseo-provider-dsh without touching anything else.
#
# The script is the exact inverse of install.sh:
#   - removes the plugin key from the Paseo daemon config;
#   - removes the bridge package from the dedicated DSH profile;
#   - removes this plugin's entries from that profile's patch layer, restoring the
#     pre-install backup when one exists;
#   - deletes the dedicated profile only when asked to (--purge-profile).
#
# It never touches the web/desktop/headless profiles and never deletes harness
# sessions, so history stays readable in DeepSeek Harness after an uninstall.
set -euo pipefail

PROFILE="${DSH_PASEO_PROFILE:-paseo-dsh}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PASEO_CONFIG="${PASEO_CONFIG:-$HOME/.paseo/config.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
PURGE_PROFILE=0
[ "${1:-}" = "--purge-profile" ] && PURGE_PROFILE=1

info() { printf '  %s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }

case "$PROFILE" in
  web|desktop|headless) echo "refusing to modify the '$PROFILE' profile" >&2; exit 1 ;;
esac

step "Paseo plugin registration"
if [ -f "$PASEO_CONFIG" ]; then
  cp "$PASEO_CONFIG" "$PASEO_CONFIG.bak.uninstall.$(date +%Y%m%d-%H%M%S)"
  node - "$PASEO_CONFIG" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.plugins && config.plugins["paseo-provider-dsh"]) {
  delete config.plugins["paseo-provider-dsh"];
  if (Object.keys(config.plugins).length === 0) delete config.plugins;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log("  removed paseo-provider-dsh from the daemon config");
} else {
  console.log("  plugin was not registered");
}
NODE
else
  info "no Paseo config at $PASEO_CONFIG"
fi

step "DSH profile '$PROFILE'"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
if [ -d "$PROFILE_DIR" ]; then
  if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm; else PNPM="$PLUGIN_ROOT/node_modules/.bin/pnpm"; fi
  ( cd "$PROFILE_DIR" && "$PNPM" remove dsh-paseo-bridge >/dev/null 2>&1 ) \
    && info "removed the bridge package" || info "bridge package was not installed"
  # A `link:` install leaves the symlink behind on some pnpm versions; remove it
  # explicitly so a later `dsh --dump-config` cannot still resolve the bridge.
  if [ -L "$PROFILE_DIR/node_modules/dsh-paseo-bridge" ] || [ -e "$PROFILE_DIR/node_modules/dsh-paseo-bridge" ]; then
    rm -rf "$PROFILE_DIR/node_modules/dsh-paseo-bridge"
    info "removed the leftover bridge symlink"
  fi

  PATCH="$PROFILE_DIR/cordis.patch.yml"
  if [ -f "$PATCH" ]; then
    # Restore the most recent pre-install backup, else strip only our lines.
    BACKUP="$(ls -t "$PATCH".bak.* 2>/dev/null | head -1 || true)"
    if [ -n "$BACKUP" ]; then
      cp "$BACKUP" "$PATCH"
      info "restored $PATCH from $BACKUP"
    else
      node - "$PATCH" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const text = fs.readFileSync(path, "utf8");
// Remove only the blocks this installer writes.
const cleaned = text
  .replace(/- id: web-runtime\n  config:\n    printUrl: false\n/g, "")
  .replace(/- insert:\n    - id: paseo-bridge\n      name: dsh-paseo-bridge\n      config:\n        enabled: true\n/g, "")
  .replace(/# Added by paseo-provider-dsh on [^\n]*\n/g, "");
fs.writeFileSync(path, cleaned);
console.log("  stripped this plugin's patch entries");
NODE
    fi
  fi
else
  info "profile $PROFILE does not exist"
fi

step "Reset the Paseo daemon"
info "restart Paseo (or run: paseo plugin reload) so the provider disappears"

if [ "$PURGE_PROFILE" = "1" ] && [ -d "$PROFILE_DIR" ]; then
  step "Purging the dedicated profile"
  rm -rf "$PROFILE_DIR"
  info "deleted $PROFILE_DIR"
  info "harness sessions in $DSH_HOME_DIR/sessions were NOT touched"
fi

echo
echo "✔ Uninstalled."
