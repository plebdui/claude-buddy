#!/bin/sh
# Links Claude Buddy into place. Run from anywhere; re-running is safe.
set -e
here=$(cd "$(dirname "$0")" && pwd)
ext="$HOME/.local/share/gnome-shell/extensions/claude-buddy@machine_face"
mkdir -p "$(dirname "$ext")" "$HOME/.local/bin" "$HOME/.config/claude-buddy"
ln -sfn "$here/extension" "$ext"
ln -sf "$here/bin/claude-buddy-craft" "$HOME/.local/bin/claude-buddy-craft"
# Your phrases are yours to edit, so only copy the defaults if you have none.
[ -e "$HOME/.config/claude-buddy/phrases.txt" ] || cp "$here/phrases.txt" "$HOME/.config/claude-buddy/phrases.txt"
echo "Installed. Log out and back in, then: gnome-extensions enable claude-buddy@machine_face"
