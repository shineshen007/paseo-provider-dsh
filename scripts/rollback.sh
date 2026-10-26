#!/usr/bin/env bash
# Roll back paseo-provider-dsh to a previous state.
#
# Two rollback shapes are supported, because they answer different failures:
#
#   scripts/rollback.sh             # undo the install (alias of uninstall.sh)
#   scripts/rollback.sh --list      # show the backups an install left behind
#   scripts/rollback.sh --restore <backup>   # restore one specific backup file
#
# Every file this project edits is copied before it is changed, so a rollback
# never has to guess at the original content.
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PASEO_CONFIG="${PASEO_CONFIG:-$HOME/.paseo/config.json}"
PROFILE="${DSH_PASEO_PROFILE:-paseo-dsh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"

case "${1:-}" in
  --list)
    echo "Backups from previous installs:"
    ls -lt \
      "$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml".bak.* 2>/dev/null || true
    ls -lt "$PASEO_CONFIG".bak.* 2>/dev/null || true
    ;;
  --restore)
    target="${2:-}"
    [ -n "$target" ] || { echo "usage: rollback.sh --restore <backup-file>" >&2; exit 1; }
    [ -f "$target" ] || { echo "no such backup: $target" >&2; exit 1; }
    case "$target" in
      *.bak.*cordis.patch.yml|*/cordis.patch.yml.bak.*)
        dest="$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml" ;;
      *config.json.bak.*)
        dest="$PASEO_CONFIG" ;;
      *)
        echo "unrecognized backup name; expected a *.bak.<timestamp> file created by install.sh" >&2
        exit 1 ;;
    esac
    cp "$dest" "$dest.pre-restore.$(date +%Y%m%d-%H%M%S)"
    cp "$target" "$dest"
    echo "restored $dest from $target"
    echo "restart the Paseo daemon to apply"
    ;;
  ""|--undo)
    exec "$PLUGIN_ROOT/scripts/uninstall.sh"
    ;;
  *)
    echo "usage: rollback.sh [--list | --restore <backup> | --undo]" >&2
    exit 1
    ;;
esac
