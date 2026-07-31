# Deploying Polystream to the VPS

Target setup: the app runs as a Docker container bound to `127.0.0.1:3000`, and your
**existing host nginx** reverse-proxies your domain to it (TLS via the Let's Encrypt /
certbot you already have). Docker exposes **nothing** publicly.

Replace **`YOUR_DOMAIN`** (e.g. `tv.mydomain.ch`) everywhere below. It appears in exactly
three places: the nginx `server_name`, the `certbot -d` flag, and `PUBLIC_APP_URL` in `.env`.

---

## 1. Push the code (from your Mac)

Already done for you: `git init` + first commit. Create an **empty private** repo on your
git host, then:

```sh
git remote add origin git@github.com:YOUR_USER/polystream.git   # your repo URL
git push -u origin main
```

> `.env` and `data/` are gitignored — secrets are **not** in the repo. You'll copy `.env`
> to the server separately in step 4.

---

## 2. On the VPS: install Docker (skip if already present)

```sh
# check first:
docker --version && docker compose version

# if missing (Ubuntu/Debian):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # then log out and back in so the group applies
```

The convenience script installs Docker Engine + the Compose v2 plugin (`docker compose`).

---

## 3. Clone the repo on the VPS

```sh
sudo mkdir -p /srv/polystream && sudo chown $USER:$USER /srv/polystream
git clone https://github.com/manuelerdoes/polystream.git /srv/polystream
cd /srv/polystream
```

---

## 4. Put the real `.env` on the server

The `.env` is not in git. Copy your local one up (run this **from your Mac**):

```sh
scp .env YOUR_USER@YOUR_VPS:/srv/polystream/.env
```

Then on the VPS, edit one value so cookies/links use the real host:

```sh
# /srv/polystream/.env
PUBLIC_APP_URL="https://YOUR_DOMAIN"
```

Everything else (WebDAV creds, TMDB key, `APP_SHARED_PASSWORD`, `SESSION_SECRET`,
`MAX_TRANSCODE_JOBS=1`) carries over as-is. `DATA_DIR`/`PORT` are set by compose — leave them.

---

## 5. Build & start the container

```sh
cd /srv/polystream
docker compose up -d --build      # first build is a few minutes (compiles better-sqlite3, pulls ffmpeg)
docker compose logs -f            # watch it boot; Ctrl-C to stop watching
```

Health check from the VPS itself:

```sh
curl -I http://127.0.0.1:3000     # expect an HTTP response (200/302)
```

The SQLite DB + on-disk caches live in the `polystream-data` Docker volume, mounted at
`/data`. They survive rebuilds and restarts.

---

## 6. nginx site + TLS

```sh
sudo cp deploy/nginx-polystream.conf /etc/nginx/sites-available/tv
sudo sed -i 's/YOUR_DOMAIN/tv/' /etc/nginx/sites-available/tv
sudo ln -s /etc/nginx/sites-available/tv /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tv.bitesnbytes.ch     # adds the 443 block + HTTP->HTTPS redirect in place
```

That nginx config already has the streaming-critical bits: `proxy_buffering off`,
HTTP/1.1 with a cleared `Connection` header, no body-size cap, and long read/send timeouts.

Open `https://YOUR_DOMAIN` — you should get the shared-password login.

---

## Redeploying later

```sh
# on the VPS:
cd /srv/polystream && git pull && docker compose up -d --build
```

---

## Notes / things to watch

- **Storage / caching.** You flagged limited disk. The app caches transcoded HLS segments
  and artwork under `/data`, capped by `HLS_CACHE_MAX_MB` / `ASSET_CACHE_MAX_MB` in `.env`.
  Set those to fit your disk. Check usage with `docker system df -v` (look for the
  `polystream-data` volume). To reclaim: `docker compose down && docker volume rm polystream_polystream-data`
  (wipes the DB + caches; the app rebuilds them on next scan).
- **Transcoding is CPU-heavy.** `MAX_TRANSCODE_JOBS=1` is correct for a small VPS. Prefer
  pre-processing files with `scripts/prepare-media.sh` before upload so playback is mostly
  direct-play and rarely needs live transcoding.
- **Firewall.** The container binds `127.0.0.1` only, so nothing new needs opening — your
  existing 80/443 rules for nginx are all that's exposed.
- **`docker compose up -d --build` only rebuilds when files change**; a no-op pull + up is cheap.
