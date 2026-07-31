# Polystream

Polystream is a SvelteKit web app that streams movies and TV shows from a Nextcloud
WebDAV library, matching them against TMDB for artwork/metadata and picking the cheapest
playback path (direct play → client-side decode → server transcode) each device supports.
See [`plan.md`](./plan.md) for the full design and [`CLAUDE.md`](./CLAUDE.md) for the
original brief. This is the **Phase 0** foundation: project scaffold, DB, and deploy
artifacts only — no app features yet.

## Local dev

```sh
cp .env.example .env   # fill in WebDAV, TMDB, password/session secrets
npm install
npm run db:migrate     # optional: applies migrations up front (the app also does this on boot)
npm run dev            # http://localhost:5173
```

Other useful scripts: `npm run build`, `npm run preview`, `npm run start` (runs the
built Node server), `npm run lint`, `npm run format`, `npm run check`.

## Deploy

Runs as a Docker container bound to `127.0.0.1:3000`, reverse-proxied by the host's
existing nginx (TLS via certbot) — no ports are exposed publicly by Docker itself.

```sh
cp .env.example .env   # fill in real values on the server
docker compose up -d --build
```

The SQLite DB and on-disk caches persist in the `polystream-data` named volume (mounted
at `/data` in the container).

Then wire up nginx + TLS:

```sh
sudo cp deploy/nginx-polystream.conf /etc/nginx/sites-available/tv.domain.ch
sudo ln -s /etc/nginx/sites-available/tv.domain.ch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tv.domain.ch
```

Edit `deploy/nginx-polystream.conf` first if your domain isn't `tv.domain.ch`.

## Preparing media before upload

Use `scripts/prepare-media.sh` — it probes any `.mkv` / `.mp4` / `.avi` and does the minimum
needed to make a browser-ready faststart `.mp4`, so you never have to pick ffmpeg flags by hand:

```bash
# one file, a batch, or a whole folder:
scripts/prepare-media.sh "Bad.Sisters.S02E04.mp4"
scripts/prepare-media.sh *.mkv
```

What it does automatically:

- **video** — H.264 8-bit is copied (lossless). 10-bit H.264 (unplayable in browsers) or any
  other codec is re-encoded to 8-bit H.264. **HEVC/H.265 is kept by default** (best quality;
  plays on capable devices, and the app can make an H.264 fallback on demand).
- **audio** — downmixed to **stereo AAC** by default (multichannel AAC plays in Safari/Chrome
  but often not in Firefox, so stereo is the only "identical everywhere" choice). Already-stereo
  AAC is copied losslessly; `--surround` keeps the original 5.1/7.1 channels.
- **subtitles** — embedded text subs are carried in as `mov_text`; external `.srt` sidecars are
  left untouched (keep the same base filename so the app still pairs them).
- always adds `-movflags +faststart`. Output is `<name>.mp4`; the source is kept for `.mkv`/`.avi`
  and replaced in place for `.mp4` (only after a verified conversion).

Flags: `--to-h264` (also convert HEVC → H.264 for universal playback), `--surround` (keep 5.1/7.1
instead of downmixing to stereo), `--help`.