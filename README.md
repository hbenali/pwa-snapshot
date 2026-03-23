# pwa-snapshot

Crawls a live PWA, bundles its manifest + icons into a self-contained zip, and
lets a GitHub Actions TWA build consume it — no live server required at build time.

---

## Project structure

```
pwa-snapshot/
├── src/
│   ├── cli.js          ← CLI entry point (reads env vars + flags)
│   └── snapshot.js     ← core fetch / pack logic
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── package.json
└── .github/workflows/build-twa-from-snapshot.yml   ← GitHub Actions workflow
```

---

## Quick-start (Docker — recommended)

```bash
# 1. Build the image
docker build -t pwa-snapshot .

# 2. Run — output lands in ./dist on your host
docker run --rm \
  -e PWA_URL=https://myapp.example.com \
  -v $(pwd)/dist:/output \
  pwa-snapshot
```

The zip is written to `./dist/pwa-snapshot.zip`.

### With docker-compose

```bash
cp .env.example .env
# Edit .env: set PWA_URL at minimum
docker compose run --rm pwa-snapshot
```

### With an env file (no Compose)

```bash
cp .env.example .env
# Edit .env
docker run --rm --env-file .env -v $(pwd)/dist:/output pwa-snapshot
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PWA_URL` | _(required)_ | PWA page or manifest URL |
| `OUTPUT_PATH` | `/output/pwa-snapshot.zip` | Zip path **inside** the container |
| `ICON_SIZES` | `48,72,96,144,192,512` | Sizes to generate if missing (needs sharp) |
| `NO_RESIZE` | `false` | Set `"1"` to skip icon generation |
| `REQUEST_TIMEOUT` | `15000` | HTTP timeout per request (ms) |
| `VERBOSE` | `false` | Set `"1"` to log every fetched URL |

> **Output path vs volume mount:** `OUTPUT_PATH` controls where the zip lands
> *inside* the container. Change *where it appears on your host* by adjusting
> the `-v` mount, e.g. `-v /home/me/releases:/output`.

CLI flags mirror every env var and take precedence:

```
node src/cli.js --help

  Arguments:
    [url]               PWA URL (overrides $PWA_URL)

  Options:
    -o, --output        output zip path
    --icon-sizes        comma-separated sizes (px)
    --no-resize         skip generating missing sizes
    --timeout           HTTP timeout (ms)
    --verbose           print every fetched URL
```

---

## Zip contents

```
pwa-snapshot.zip
├── manifest.json       ← enriched: icon srcs rewritten to local paths
├── meta.json           ← extracted fields (name, themeColor, startUrl, …)
└── icons/
    ├── 192x192_0.png
    ├── 512x512_1.png
    └── generated_48.png   ← only when sharp is installed and size was missing
```

---

## Hosting the zip

Any host with a stable, public direct-download URL works.

### GitHub Release (recommended)

```bash
gh release create v1.0.0 dist/pwa-snapshot.zip \
  --title "PWA snapshot v1.0.0"
# → https://github.com/<user>/<repo>/releases/download/v1.0.0/pwa-snapshot.zip
```

### S3

```bash
aws s3 cp dist/pwa-snapshot.zip s3://my-bucket/pwa-snapshot.zip --acl public-read
```

### Cloudflare R2, Bunny, Netlify

Upload the file, copy the direct link. It just needs `200 OK` with no auth.

---

## GitHub Actions workflow

Place `build-twa-from-snapshot.yml` in `.github/workflows/`.

The workflow has **two modes**:

### Mode A — pre-built zip (recommended for private/offline PWAs)

```
Actions → Build TWA from snapshot → Run workflow
  snapshot_url: https://github.com/.../releases/download/v1.0/pwa-snapshot.zip
  app_id: com.example.myapp
```

### Mode B — build snapshot inside CI (PWA must be reachable from GitHub runners)

```
Actions → Build TWA from snapshot → Run workflow
  pwa_url: https://myapp.example.com   ← leave snapshot_url blank
  app_id: com.example.myapp
```

In mode B, the workflow builds the Docker image from source, runs
`pwa-snapshot`, and passes the zip between jobs as a workflow artifact
(retention: 1 day — only needed for that run).

### Required secrets

| Secret | Purpose |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w 0 my-key.jks` |
| `KEYSTORE_ALIAS` | Alias used with `keytool` |
| `KEYSTORE_PASSWORD` | Keystore password |
| `KEY_PASSWORD` | Key password |
| `APPLE_CERTIFICATE_BASE64` | _(optional)_ `.p12` as base64 |
| `APPLE_CERTIFICATE_PASSWORD` | _(optional)_ `.p12` export password |
| `APPLE_PROVISIONING_PROFILE` | _(optional)_ Profile name |

---

## Local install (without Docker)

```bash
npm install          # node >= 18 required
npm install sharp    # optional: icon resizing

# Link globally
npm link
pwa-snapshot https://myapp.example.com -o dist/snapshot.zip
```

---

## Android: Digital Asset Links

For the TWA to display without a browser address bar, serve this at
`https://yourdomain.com/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.myapp",
    "sha256_cert_fingerprints": ["YOUR_KEYSTORE_SHA256"]
  }
}]
```

Get the fingerprint:
```bash
keytool -list -v -keystore my-key.jks -alias my-alias
```
