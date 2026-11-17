#!/usr/bin/env sh
set -eu

ACTION="${1:-install}"
case "$ACTION" in install|uninstall) ;; *) printf 'Unknown action: %s\n' "$ACTION" >&2; exit 1 ;; esac
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
SRC="$(CDPATH= cd -- "$SCRIPT_DIR/../agy-capsule" && pwd -P)"
PLUGIN_ROOT="${AGY_CAPSULE_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"

if [ "$ACTION" = install ]; then
    test -f "$SRC/plugin.json" || { printf 'Source plugin manifest missing\n' >&2; exit 1; }
    mkdir -p -- "$PLUGIN_ROOT"
elif [ ! -d "$PLUGIN_ROOT" ]; then
    printf 'agy-capsule is not installed. Preferences were kept.\n'
    exit 0
fi
PLUGIN_ROOT="$(CDPATH= cd -- "$PLUGIN_ROOT" && pwd -P)"
DST="$PLUGIN_ROOT/agy-capsule"
test ! -L "$DST" || { printf 'Plugin destination is a link; remove the link manually: %s\n' "$DST" >&2; exit 1; }
test "$DST" != "$SRC" || { printf 'Source and destination must differ\n' >&2; exit 1; }

if [ "$ACTION" = uninstall ]; then
    rm -rf -- "$DST"
    printf 'Removed %s\nPreferences were kept. Reload open Antigravity pages to clear any remaining UI.\n' "$DST"
    exit 0
fi

mkdir -p -- "$DST"
MARKER="$DST/.update-in-progress"
printf 'Updating agy-capsule\n' > "$MARKER"
trap 'rm -f -- "$MARKER"' 0
trap 'exit 1' 1 2 15
# Keep the marker present while replacing the installed files, including stale files.
find "$DST" ! -path "$DST" -prune ! -name '.update-in-progress' -exec rm -rf -- {} +
cp -R "$SRC/." "$DST/"
printf 'Installed/updated agy-capsule at %s\n' "$DST"
printf 'Enable it in Antigravity Plugins on first install. Updates auto-restart a running reload-enabled version.\n'
