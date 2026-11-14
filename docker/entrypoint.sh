#!/bin/sh
# Runs the app as PUID:PGID (Unraid: 99:100) so files written to /config and /books
# belong to the right user on the host. If the container was started with --user, we
# are not root and just run the command as that user.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-022}"
CONFIG_DIR="${CONFIG_DIR:-/config}"

umask "$UMASK"

# Backup commands: `docker run --rm -v <appdata>:/config <image> restore latest`.
# They run as whoever already owns /config, so a restore never changes file ownership.
case "${1:-}" in
  backup|restore|list-backups)
    if [ "$(id -u)" = "0" ] && [ -d "$CONFIG_DIR" ] && [ "$(stat -c '%u' "$CONFIG_DIR")" != "0" ]; then
      PUID="$(stat -c '%u' "$CONFIG_DIR")"
      PGID="$(stat -c '%g' "$CONFIG_DIR")"
    fi
    set -- node /app/apps/server/dist/backup/cli.js "$@" ;;
esac

case "$PUID$PGID" in
  *[!0-9]*) echo "bookbandit: PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR" "${CALIBRE_TEMP_DIR:-/tmp/calibre}"
  # Only walk /config when its owner is wrong (first start, or PUID/PGID changed).
  # /books is never chowned: it is your library and may be large or shared with other apps.
  if [ "$(stat -c '%u:%g' "$CONFIG_DIR")" != "$PUID:$PGID" ]; then
    echo "bookbandit: setting owner of $CONFIG_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$CONFIG_DIR"
  fi
  chown "$PUID:$PGID" "${CALIBRE_TEMP_DIR:-/tmp/calibre}"
  if [ "$PUID" = "0" ]; then
    echo "bookbandit: warning: running as root (PUID=0)" >&2
    exec "$@"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

mkdir -p "${CALIBRE_TEMP_DIR:-/tmp/calibre}" 2>/dev/null || true
exec "$@"
