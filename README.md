<h1 align="center">xlabplayer</h1>

<p align="center">
  <img src="public/icon.svg" width="128" alt="xlabplayer logo">
</p>

<p align="center"><b>Your music, your server, plus YouTube.</b></p>

<p align="center"><a href="#quick-start--docker-compose-recommended">Install</a> · <a href="#features">Features</a> · <a href="#why-xlabplayer">Why xlabplayer</a> · <a href="#updating-xlabplayer">Updating</a></p>

xlabplayer is a music player you run at home. Point it at your own library, search and stream from YouTube, and save songs you want to keep. Open it on your iPhone, Android or PC and install it like an app. No subscription, and your library stays on your own server.


[![Docker image](https://github.com/CJNG20u/xlab-player/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/CJNG20u/xlab-player/pkgs/container/xlab-player)

🐳 **Docker image:** `ghcr.io/cjng20u/xlab-player:latest` (amd64 + arm64)

```bash
docker pull ghcr.io/cjng20u/xlab-player:latest
```
<img width="1682" height="1297" alt="image" src="https://github.com/user-attachments/assets/95e1bbf1-1242-4626-880a-0eb7f2b2204d" />


Self-hosted Spotify-style music player and PWA for your NAS, with built-in yt-dlp search, inline audio preview, and automatic metadata tagging.

## Why xlabplayer?

- **Your music, your server.** Runs in Docker on your own hardware. No subscriptions, no accounts with a third party, no cloud.
- **Everything in one player.** Your NAS library and YouTube streaming share one queue.
- **Works on every device.** Installable PWA for iPhone, Android and PC, with lock-screen controls.
- **Free to use and download.** Stream online and save songs to your own library.
- **Made for your setup.** Lyrics, offline playback, playlists and multi-user roles.

## Features
Local & NAS Audio Streaming: Streams .m4a, .opus, .flac, .mp3, .ogg, and .wav directly from your local drive or mounted NFS/SMB share with HTTP 206 byte-range seeking and instant library indexing.

On-Demand YouTube & YouTube Music Streaming: Search tracks 
Unified Local & Online Queue: Seamlessly mix local NAS/drive tracks and live YouTube streams inside the same playback queue with Next/Previous skipping and continuous playback.

Gesture-Driven Now Playing & Multi-Theme UI: Switch between custom Spotify and Apple Music visual themes, extract CORS-safe dominant album colors via /api/yt-thumb/:videoId, and skip tracks effortlessly with album-art swipe gestures.

Automatic Cover Cropping & Tag Embedding: Powered by yt-dlp and ffmpeg to extract audio, crop thumbnails to crisp 1:1 square artwork, embed ID3/MP4 tags, and organize tracks cleanly under Artist/Album/Track.

Synced .lrc & Embedded Lyrics: Reads sidecar .lrc files live alongside embedded audio lyrics.

Navigation & Library Organization: Primary navigation across **Home** (personalized recommendations, new releases, and search), **Library** (Playlists, Artists, Albums, Songs, Downloaded, Liked, and Cached tracks), and **Settings**.

Playlists & .m3u / .m3u8 Sync: Create and manage playlists inside Library, auto-import .m3u/.m3u8 playlists from your music library, and export any playlist back to <MUSIC_DIR>/Playlists/.

Installable PWA with MediaSession Controls: Responsive desktop and mobile web app with offline shell caching and native lock-screen, Bluetooth, and CarPlay/Android Auto playback controls.

Offline PWA Caching (iOS & Android): Save individual tracks or entire playlists locally using the browser Cache Storage API and IndexedDB for zero-network playback in Airplane Mode.

Background & Lock-Screen Playback: Persistent HTML5 audio engine integrated with the Media Session API (navigator.mediaSession) for uninterrupted lock-screen playback and hardware controls on iOS and Android.

Multi-User Roles & cookies.txt Support: Separate admin and listener roles, per-user download permissions, direct local audio uploads, and Netscape-format cookies.txt management for resilient YouTube downloads and streams.

Zero-Cloud Architecture: Runs completely locally in Docker with persistent /music volume mapping and zero external AI or third-party cloud API dependencies.

---

## Quick Start — Docker Compose (Recommended)

### 1. Clone & Configure

```bash
git clone https://github.com/CJNG20u/xlab-player.git /opt/xlab-playercd xlab-player
cd /opt/xlab-player
cp .env.example .env
```

Generate a strong `JWT_SECRET` and add it to `.env` (or leave `JWT_SECRET` blank to auto-generate and persist one in SQLite on first boot):

```bash
openssl rand -hex 32
```

Open `.env` and set `JWT_SECRET`, `COOKIE_SECURE` (`true` if behind an HTTPS reverse proxy, `false` for plain HTTP on a local LAN), and `PUID`/`PGID` to match your host/NAS user.

### 2.Point docker-compose.yml to /music & Build Fresh

```bash
sed -i 's|- ./music_library:/PATH|- /music:/PATH|g' docker-compose.yml
docker compose up -d --build
```

Check container status and logs:

```bash
docker compose ps
docker compose logs -f xlabplayer
```

Once healthy, open `http://<your-server-ip>:3000`.

### Volume Mapping

`docker-compose.yml` mounts three persistent directories:

| Host Path | Container Path | Purpose |
| --- | --- | --- |
| `./data` | `/app/data` | SQLite database (`xlabplayer.db` + `stream_url_cache`), extracted album cover cache, `yt-dlp` JS player cache, and uploaded `cookies.txt` |
| `./audio_cache` | `/app/data/audio-cache` | LRU-evicted disk audio cache for streamed/prefetched tracks (controlled by `AUDIO_CACHE_MB`, default `2048` MB; mount on fast local SSD and keep out of git/backups) |
| `./music_library` | `/music` | Music library root (`MUSIC_DIR`) for scanning, streaming, downloads, uploads, and `.m3u8` exports |

To connect an existing NFS or SMB NAS share mounted on the Docker host (for example `/mnt/nas/music`), update the volume entry in `docker-compose.yml`:

```yaml
volumes:
  - ./data:/app/data
  - ./audio_cache:/app/data/audio-cache
  - /mnt/nas/music:/music
```

> **Read-Only NAS Mounts:** Append `:ro` (`/mnt/nas/music:/music:ro`) if you only want streaming and library scanning without allowing downloads, uploads, or track deletions.

### NAS Permissions (`PUID` / `PGID`)

On startup, `docker-entrypoint.sh` ensures `/app/data`, `/app/data/audio-cache`, and `/music` exist, aligns ownership of `/app/data` and `/app/data/audio-cache` to `PUID:PGID`, and drops root privileges via `gosu` before starting Node.js. It intentionally avoids recursive `chown` over `/music` so large or read-only NAS shares start instantaneously.

Find your host/NAS user and group IDs:

```bash
id -u   # set as PUID in .env
id -g   # set as PGID in .env
```

### Using Prebuilt GHCR Images

Automated multi-arch (`linux/amd64`, `linux/arm64`) images are published to GitHub Container Registry on pushes to `main` (`:latest`) and on every release (version tags like `:2.7.0` and `:2`). To pull a prebuilt image instead of building locally, comment out `build: .` in `docker-compose.yml` and uncomment:

```yaml
image: ghcr.io/cjng20u/xlab-player:latest
```

Then run:

```bash
docker compose pull && docker compose up -d
```

---

## Bare-Metal Linux / Debian Installation

### 1. Install Prerequisites

Install Node.js 22+, native build tools (for `better-sqlite3`), `ffmpeg`, `python3`, and the latest `yt-dlp` binary:

```bash
# System packages & build toolchain
sudo apt-get update
sudo apt-get install -y curl ca-certificates git build-essential python3 ffmpeg

# Node.js 22.x (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Pinned official yt-dlp binary (recommended version to avoid YouTube ad-gate slow starts)
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
printf '%s\n' '--js-runtimes node' '--no-update' | sudo tee /etc/yt-dlp.conf > /dev/null
```

### 2. Clone, Build & Configure

```bash
sudo mkdir -p /opt/xlab-player
sudo chown "$USER:$USER" /opt/xlab-player
git clone https://github.com/CJNG20u/xlab-player.git /opt/xlab-player
cd /opt/xlab-player

# Install dependencies and build the production frontend
# (Use `npm install` instead of `npm ci` if package-lock.json is not present)
npm ci && npm run build

# Create and edit your environment file
cp .env.example .env
```

Update `.env` for your bare-metal paths (for example):

```env
PORT=3000
JWT_SECRET=<paste-output-of-openssl-rand-hex-32>
COOKIE_SECURE=false
DATA_DIR=/opt/xlab-player/data
MUSIC_DIR=/mnt/nas/music
YTDLP_PATH=/usr/local/bin/yt-dlp
FFMPEG_PATH=/usr/bin/ffmpeg
```

Test starting the production server:

```bash
npm start
```

### 3. Run as a `systemd` Service

Create `/etc/systemd/system/xlabplayer.service` (replace `<your-user>` with the Linux user that owns `/opt/xlab-player` and has access to your music directory):

```ini
[Unit]
Description=xlabplayer Self-Hosted Music Server
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=<your-user>
Group=<your-user>
WorkingDirectory=/opt/xlab-player
Environment=NODE_ENV=production
EnvironmentFile=/opt/xlab-player/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xlabplayer
sudo systemctl status xlabplayer
```

---

## Environment Variables Reference

| Variable | Default (Docker) | Default (Bare-Metal) | Description |
| --- | --- | --- | --- |
| `PORT` | `3000` | `3000` | HTTP port the Express server listens on. |
| `JWT_SECRET` | *(auto-generated)* | *(auto-generated)* | Secret key (16+ chars, 32+ recommended) for signing JWT session tokens. If left blank, a random 64-char hex secret is generated and persisted in SQLite. |
| `COOKIE_SECURE` | `false` | `false` | Set to `true` when serving over HTTPS behind a reverse proxy so auth cookies include the `Secure` attribute. |
| `DATA_DIR` | `/app/data` | `./data` | Directory storing `xlabplayer.db`, extracted cover art (`covers/`), and `secrets/cookies.txt`. |
| `AUDIO_CACHE_DIR` | `/app/data/audio-cache` | `./data/audio-cache` | Persistent disk cache directory for streamed and prefetched audio files. |
| `AUDIO_CACHE_MB` | `2048` | `2048` | Maximum disk audio cache size in MB (`0` disables disk caching). |
| `YT_AD_GATE_MAX_WAIT_MS` | `12000` | `12000` | Max TV ad-gate polling window in ms for interactive playback. |
| `YT_AD_GATE_MAX_WAIT_PREFETCH_MS` | `25000` | `25000` | Max TV ad-gate polling window in ms for background prefetch (clamped `1000-120000`). |
| `YT_DISABLE_FAST_PATH` | `0` | `0` | Set to `1` to never run the `android-vr-fast` strategy or fetch `visitor_data` for it. Even when `0`, `android-vr-fast` auto-disables for 30 minutes after 3 consecutive bot-check rejections. |
| `MUSIC_DIR` | `/music` | `./music_library` | Initial music library path seeded into the database on first boot (can later be changed in **Settings**). |
| `YTDLP_VERSION` | `2026.08.19` | *(Docker build arg)* | Pinned `yt-dlp` release tag installed in the Docker image. Override to test a newer release. |
| `YTDLP_PATH` | `/usr/local/bin/yt-dlp` | `yt-dlp` | Path or command name for the `yt-dlp` binary seeded on first boot. |
| `FFMPEG_PATH` | `/usr/bin/ffmpeg` | `ffmpeg` | Path or command name for the `ffmpeg` binary seeded on first boot. |
| `PUID` | `1000` | *(Docker only)* | Numeric user ID used by `docker-entrypoint.sh` when dropping privileges via `gosu`. |
| `PGID` | `1000` | *(Docker only)* | Numeric group ID used by `docker-entrypoint.sh` when dropping privileges via `gosu`. |

---

## First-Time Setup & Updating

### Initial Admin Setup & Library Scan

1. Open `http://<your-server-ip>:3000` in your browser. On first boot with an empty database, `xlabplayer` displays the initial setup screen to create your **Admin** account.
2. Navigate to **Settings** to verify your **Music Directory** (defaults to `/music` in Docker or `MUSIC_DIR` from `.env`), inspect mount health/permissions, and run **Scan Library** to index tracks and `.m3u`/`.m3u8` playlists.
3. *(Optional)* In **Settings**, create additional **Listener** accounts, toggle per-user download permissions, or upload a Netscape-format `cookies.txt` file for age-restricted or rate-limited YouTube downloads.

### Updating `xlabplayer`

**Docker Compose (local build):**
```bash
git pull
docker compose up -d --build
```

**Docker Compose (GHCR image):**
```bash
docker compose pull
docker compose up -d
```

**Bare-Metal (`systemd`):**
```bash
cd /opt/xlab-player
git pull
npm ci && npm run build
sudo systemctl restart xlabplayer
```

### `yt-dlp` Version Pin & Testing Newer Versions

Docker builds pin `yt-dlp` to **`2026.08.19`** (with `--no-update` in `/etc/yt-dlp.conf`) because newer releases can reintroduce slow playback starts triggered by YouTube's ad gate.

If YouTube extractor changes break playback or you want to test a newer release:

- **Override via `.env` and rebuild (Docker Compose):**
  Set `YTDLP_VERSION=<release-tag>` (for example `YTDLP_VERSION=2026.09.01`) in `.env`, then run:
  ```bash
  docker compose build --no-cache && docker compose up -d
  ```
- **One-off build argument override (Docker Compose):**
  ```bash
  docker compose build --build-arg YTDLP_VERSION=<release-tag> --no-cache && docker compose up -d
  ```
- **Temporary in-place update inside a running container (resets on recreate):**
  ```bash
  docker compose exec -u root xlabplayer /usr/local/bin/yt-dlp -U
  ```
- **Bare-Metal Linux:**
  Download a specific release tag directly (recommended so you can easily roll back to `2026.08.19`):
  ```bash
  sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/<release-tag>/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  ```
  *(You can also run `yt-dlp -U` from the **Settings** page when running bare-metal with write permissions to the binary.)*

---

## Automatic Audio Quality (Always On)

Audio quality optimizations run automatically with no settings or environment flags required:

- **Better YouTube source matching:** Catalog/metadata matches evaluate `ytsearch8:<title> <artist>` flat results using normalized title similarity, channel-only artist comparison, duration proximity, whole-word wrong-version penalties (live, cover, karaoke, remix, slowed/reverb, etc. in both directions), and official/`- Topic`/VEVO source preference. Only matches scoring `>= 0.40` are saved in the 14-day `track_video_map` cache.
- **Background audio QC & auto-rejection:** After a cached stream finishes filling, a single low-priority background `ffmpeg` EBU R128 pass measures integrated loudness (LUFS), true peak, duration, and momentary loudness once per video (skipping while the resolver queue is busy). Artist+title matches that are nearly silent, have a sustained `>= 12 dB` level drop covering `>= 25%` (`>= 20s`), or diverge from the requested duration by more than `max(15s, 8%)` are automatically evicted and recorded in `track_video_rejects` (capped at 2 rejections per track) so the next best candidate is selected on subsequent plays. Admins can inspect aggregate stats at `GET /api/yt-stream/qc-summary`.
- **Track-start loudness normalization:** At the start of each track, the player queries `GET /api/yt-stream/loudness` (cached in memory) and attenuates louder-than-`-14 LUFS` tracks via `audio.volume = userVolume * min(1, 10^((-14 - lufs) / 20))` with a smooth 150 ms ramp, without boosting quiet tracks or altering the stored/remote user volume.
- **Native-codec library downloads:** Songs and YouTube playlists downloaded to the library use `bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]` with no bitrate cap and no re-encoding; video fallbacks are remuxed to audio-only via stream copy (`-vn -c:a copy`). Streaming format selection is unchanged.

