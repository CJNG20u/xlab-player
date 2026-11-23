#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
MUSIC_DIR="${MUSIC_DIR:-/music}"

# Ensure persistent runtime directories exist (tolerate read-only NAS mounts for MUSIC_DIR)
YTDLP_CACHE_DIR="${YTDLP_CACHE_DIR:-$DATA_DIR/ytdlp-cache}"
mkdir -p "$DATA_DIR" "$YTDLP_CACHE_DIR"
[ -d "$MUSIC_DIR" ] || mkdir -p "$MUSIC_DIR" 2>/dev/null || true

export YTDLP_CACHE_DIR
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$YTDLP_CACHE_DIR}"

# If started as root, adjust ownership for NAS share compatibility and drop privileges via gosu
if [ "$(id -u)" = "0" ]; then
  TARGET_UID="${PUID:-1000}"
  TARGET_GID="${PGID:-1000}"

  if [ "$TARGET_UID" = "0" ]; then
    exec "$@"
  fi

  # Ensure group with TARGET_GID exists
  if ! getent group "$TARGET_GID" >/dev/null 2>&1; then
    groupadd -g "$TARGET_GID" xlabplayer 2>/dev/null || true
  fi

  # Ensure user with TARGET_UID exists so npm / yt-dlp have a valid passwd entry
  if ! getent passwd "$TARGET_UID" >/dev/null 2>&1; then
    useradd -u "$TARGET_UID" -g "$TARGET_GID" -d /tmp -s /bin/sh -M -N xlabplayer 2>/dev/null || true
  fi

  # Keep app data (SQLite DB, covers, secrets, yt-dlp cache) owned by the runtime UID:GID
  chown -R "${TARGET_UID}:${TARGET_GID}" "$DATA_DIR"
  if [ "$YTDLP_CACHE_DIR" != "$DATA_DIR/ytdlp-cache" ] && [ -d "$YTDLP_CACHE_DIR" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "$YTDLP_CACHE_DIR" 2>/dev/null || true
  fi

  # Adjust music directory mount root ownership if writable (never recurse over large/read-only NAS shares)
  if [ -d "$MUSIC_DIR" ] && [ -w "$MUSIC_DIR" ]; then
    chown "${TARGET_UID}:${TARGET_GID}" "$MUSIC_DIR" 2>/dev/null || true
  fi

  # Ensure writable home/cache paths for npm and persistent yt-dlp player cache after privilege drop
  export HOME="/tmp"
  export npm_config_cache="/tmp/.npm"

  exec gosu "${TARGET_UID}:${TARGET_GID}" "$@"
fi

exec "$@"
