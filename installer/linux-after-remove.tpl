#!/bin/sh
set -e

# dpkg calls postrm for upgrades too. RPM passes the number of versions left.
case "$1" in
    remove|purge|0) ;;
    *) exit 0 ;;
esac

link='/usr/bin/${executable}'
target='/opt/${sanitizedProductName}/${executable}'

# The install hook can fall back to a direct link even when the tool exists.
if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    rm -- "$link"
fi
if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' "$target"
fi
