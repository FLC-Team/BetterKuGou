#!/bin/sh
set -eu

app_dir='/opt/${sanitizedProductName}'
sandbox="$app_dir/chrome-sandbox"
target="$app_dir/${executable}"
link='/usr/bin/${executable}'

# Package installation is privileged; normal desktop launches must stay unprivileged.
if [ "$(id -u)" != 0 ]; then
    echo 'BetterKuGou: install the DEB/RPM through the system package manager as root.' >&2
    exit 1
fi
if [ -L "$app_dir" ] || [ ! -d "$app_dir" ] || [ -L "$sandbox" ] || [ ! -f "$sandbox" ]; then
    echo "BetterKuGou: refusing to configure an invalid sandbox path: $sandbox" >&2
    exit 1
fi

# Root's user-namespace probe does not describe an ordinary user's AppArmor policy.
# Only the shipped sandbox helper receives SUID; never change home-directory ownership.
chown root:root "$app_dir" "$sandbox"
chmod 0755 "$app_dir"
chmod 4755 "$sandbox"

# Replace only this application's own direct link, preserving unrelated commands.
if [ -e "$link" ] || [ -L "$link" ]; then
    if [ ! -L "$link" ]; then
        echo "BetterKuGou: refusing to replace an unrelated command: $link" >&2
        exit 1
    fi
    current=$(readlink "$link")
    case "$current" in
        "$target") rm -- "$link" ;;
        '/etc/alternatives/${executable}') ;;
        *) echo "BetterKuGou: refusing to replace an unrelated command: $link" >&2; exit 1 ;;
    esac
fi
if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --install "$link" '${executable}' "$target" 100
else
    ln -s "$target" "$link"
fi

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
