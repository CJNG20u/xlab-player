# xlabplayer

Self-hosted Spotify-style music player and PWA for your NAS, with built-in yt-dlp search, inline audio preview, and automatic metadata tagging.

## Features

- **Local & NAS Audio Streaming**: Streams `.m4a`, `.opus`, `.flac`, `.mp3`, `.ogg`, and `.wav` directly from your local drive or mounted NFS/SMB share with HTTP 206 byte-range seeking and instant library indexing.
- **YouTube & YouTube Music Search + Inline Audio Preview**: Search tracks or paste single/playlist URLs and preview audio inline before downloading.
- **Automatic Cover Cropping & Tag Embedding**: Powered by `yt-dlp` and `ffmpeg` to extract audio, crop thumbnails to crisp 1:1 square artwork, embed ID3/MP4 tags, and organize tracks cleanly under `Artist/Album/Track`.
- **Synced `.lrc` & Embedded Lyrics**: Reads sidecar `.lrc` files live alongside embedded audio lyrics.
- **Playlists & `.m3u` / `.m3u8` Sync**: Create and manage playlists in-app, auto-import `.m3u`/`.m3u8` playlists from your music library, and export any playlist back to `<MUSIC_DIR>/Playlists/`.
- **Installable PWA with MediaSession Controls**: Responsive desktop and mobile web app with offline shell caching and native lock-screen, Bluetooth, and CarPlay/Android Auto playback controls.
- **Multi-User Roles & `cookies.txt` Support**: Separate `admin` and `listener` roles, per-user download permissions, direct local audio uploads, and Netscape-format `cookies.txt` management for resilient YouTube downloads.

---

## Quick Start — Docker Compose (Recommended)

### 1. Clone & Configure

```bash
git clone https://github.com/<your-username>/xlabplayer.git
cd xlabplayer
cp .env.example .env
```

Generate a strong `JWT_SECRET` and add it to `.env` (or leave `JWT_SECRET` blank to auto-generate and persist one in SQLite on first boot):

```bash
openssl rand -hex 32
```

Open `.env` and set `JWT_SECRET`, `COOKIE_SECURE` (`true` if behind an HTTPS reverse proxy, `false` for plain HTTP on a local LAN), and `PUID`/`PGID` to match your host/NAS user.

### 2. Start the Container

```bash
docker compose up -d --build
```

Check container status and logs:

```bash
docker compose ps
docker compose logs -f xlabplayer
```

Once healthy, open `http://<your-server-ip>:3000`.

### Volume Mapping

`docker-compose.yml` mounts two persistent directories:

| Host Path | Container Path | Purpose |
| --- | --- | --- |
| `./data` | `/app/data` | SQLite database (`xlabplayer.db`), extracted album cover cache, and uploaded `cookies.txt` |
| `./music_library` | `/music` | Music library root (`MUSIC_DIR`) for scanning, streaming, downloads, uploads, and `.m3u8` exports |

To connect an existing NFS or SMB NAS share mounted on the Docker host (for example `/mnt/nas/music`), update the volume entry in `docker-compose.yml`:

```yaml
volumes:
  - ./data:/app/data
  - /mnt/nas/music:/music
```

> **Read-Only NAS Mounts:** Append `:ro` (`/mnt/nas/music:/music:ro`) if you only want streaming and library scanning without allowing downloads, uploads, or track deletions.

### NAS Permissions (`PUID` / `PGID`)

On startup, `docker-entrypoint.sh` ensures `/app/data` and `/music` exist, aligns ownership of `/app/data` to `PUID:PGID`, and drops root privileges via `gosu` before starting Node.js. It intentionally avoids recursive `chown` over `/music` so large or read-only NAS shares start instantaneously.

Find your host/NAS user and group IDs:

```bash
id -u   # set as PUID in .env
id -g   # set as PGID in .env
```

### Using Prebuilt GHCR Images

Automated multi-arch (`linux/amd64`, `linux/arm64`) images are published to GitHub Container Registry on pushes to `main`. To pull a prebuilt image instead of building locally, comment out `build: .` in `docker-compose.yml` and uncomment:

```yaml
image: ghcr.io/<your-username>/xlabplayer:latest
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

# Latest official yt-dlp binary
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 2. Clone, Build & Configure

```bash
sudo mkdir -p /opt/xlabplayer
sudo chown "$USER:$USER" /opt/xlabplayer
git clone https://github.com/<your-username>/xlabplayer.git /opt/xlabplayer
cd /opt/xlabplayer

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
DATA_DIR=/opt/xlabplayer/data
MUSIC_DIR=/mnt/nas/music
YTDLP_PATH=/usr/local/bin/yt-dlp
FFMPEG_PATH=/usr/bin/ffmpeg
```

Test starting the production server:

```bash
npm start
```

### 3. Run as a `systemd` Service

Create `/etc/systemd/system/xlabplayer.service` (replace `<your-user>` with the Linux user that owns `/opt/xlabplayer` and has access to your music directory):

```ini
[Unit]
Description=xlabplayer Self-Hosted Music Server
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=<your-user>
Group=<your-user>
WorkingDirectory=/opt/xlabplayer
Environment=NODE_ENV=production
EnvironmentFile=/opt/xlabplayer/.env
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
| `MUSIC_DIR` | `/music` | `./music_library` | Initial music library path seeded into the database on first boot (can later be changed in **Settings**). |
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
cd /opt/xlabplayer
git pull
npm ci && npm run build
sudo systemctl restart xlabplayer
```

### Updating `yt-dlp`

Because YouTube extractors change frequently, keep `yt-dlp` up to date:

- **In-place inside Docker (immediate until container recreate):**
  ```bash
  docker compose exec -u root xlabplayer /usr/local/bin/yt-dlp -U
  ```
- **Permanent Docker update (rebuilds the image with the latest release):**
  ```bash
  docker compose build --no-cache && docker compose up -d
  ```
- **Bare-Metal Linux:**
  ```bash
  sudo /usr/local/bin/yt-dlp -U
  ```
  *(You can also trigger updates directly from the **Settings** page when running bare-metal with write permissions to the binary.)*
