# Skopix · Docker Deployment Guide

Self-hosting Skopix with Docker. Three setups covered, from "quickest" to
"production with HTTPS". Pick the one that matches what you're trying to do.

---

## TL;DR

```bash
docker run -d \
  --name skopix \
  -p 9000:9000 \
  -v ~/skopix-data:/data \
  -e SKOPIX_SECRET_KEY="$(openssl rand -base64 32)" \
  -e SKOPIX_TEAM_MODE=true \
  ghcr.io/x444dyx/skopix:latest
```

Visit `http://your-server-ip:9000/setup`, create the admin account, invite your
team. Done. Read on for proper production setups with HTTPS, backups, etc.

---

## Setup 1: Quick start (HTTP, single command)

For: trying it out, internal-only use, dev environments where HTTPS doesn't
matter yet.

```bash
# Generate a strong secret key once - save it somewhere safe (1Password etc).
# You need the same key every time you restart Skopix or stored tokens won't decrypt.
SKOPIX_KEY=$(openssl rand -base64 32)
echo "Save this somewhere safe: $SKOPIX_KEY"

# Run
docker run -d \
  --name skopix \
  --restart unless-stopped \
  -p 9000:9000 \
  -v ~/skopix-data:/data \
  -e SKOPIX_SECRET_KEY="$SKOPIX_KEY" \
  -e SKOPIX_TEAM_MODE=true \
  ghcr.io/x444dyx/skopix:latest
```

Open `http://your-server-ip:9000/setup` and create the first admin account.

To follow logs:
```bash
docker logs -f skopix
```

To stop:
```bash
docker stop skopix
```

To start again:
```bash
docker start skopix
```

To update later (see Updating section below for the full story):
```bash
docker pull ghcr.io/x444dyx/skopix:latest
docker stop skopix
docker rm skopix
# Then re-run the `docker run` command above
```

---

## Setup 2: docker-compose (recommended for teams)

For: anyone running this longer than a quick test. Easier to manage than raw
`docker run` commands, and the standard way to deploy alongside other services.

**1. Create a directory:**
```bash
mkdir -p ~/skopix && cd ~/skopix
```

**2. Create `docker-compose.yml`:**
```yaml
services:
  skopix:
    image: ghcr.io/x444dyx/skopix:latest
    container_name: skopix
    restart: unless-stopped
    ports:
      - "9000:9000"
    volumes:
      - ./skopix-data:/data
    environment:
      SKOPIX_SECRET_KEY: ${SKOPIX_SECRET_KEY}
      SKOPIX_TEAM_MODE: "true"
```

**3. Create `.env`:**
```bash
echo "SKOPIX_SECRET_KEY=$(openssl rand -base64 32)" > .env
```

Add `.env` to `.gitignore` if you commit this directory. Keep it private.

**4. Start:**
```bash
docker compose up -d
```

**Common operations:**
```bash
docker compose logs -f          # tail logs
docker compose down             # stop and remove containers (data preserved)
docker compose up -d            # start
docker compose pull             # fetch latest image
docker compose up -d --force-recreate  # restart with new image
docker compose ps               # container status
```

---

## Setup 3: Production with Caddy + HTTPS (recommended)

For: any team deployment accessible over the internet.

Adds Caddy as a reverse proxy. Caddy automatically fetches and renews Let's
Encrypt TLS certificates for your domain. No `certbot`, no cron jobs, no
manual cert handling.

**Requirements:**
- A domain name (e.g. `skopix.yourcompany.com`)
- DNS A record pointing at this server's public IP
- Ports 80 and 443 reachable from the internet (Let's Encrypt verifies domain
  ownership over port 80)

**1. Create a directory and set up files:**
```bash
mkdir -p ~/skopix && cd ~/skopix
```

**2. Create `docker-compose.yml`:**
```yaml
services:
  skopix:
    image: ghcr.io/x444dyx/skopix:latest
    container_name: skopix
    restart: unless-stopped
    expose:
      - "9000"   # internal only - Caddy forwards to this
    volumes:
      - ./skopix-data:/data
    environment:
      SKOPIX_SECRET_KEY: ${SKOPIX_SECRET_KEY}
      SKOPIX_TEAM_MODE: "true"

  caddy:
    image: caddy:2
    container_name: skopix-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - skopix

volumes:
  caddy_data:
  caddy_config:
```

**3. Create `Caddyfile`:**
```
skopix.yourcompany.com {
    reverse_proxy skopix:9000

    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
    }
}
```

Replace `skopix.yourcompany.com` with your actual domain.

**4. Create `.env`:**
```bash
echo "SKOPIX_SECRET_KEY=$(openssl rand -base64 32)" > .env
```

**5. Start:**
```bash
docker compose up -d
```

**6. Wait ~30 seconds**, then visit `https://skopix.yourcompany.com`. Should
have a green padlock and a valid certificate. If the cert fetch fails, check:
```bash
docker compose logs caddy
```
Most failures are DNS not propagated yet, or ports 80/443 blocked by firewall.

---

## Workspace tokens (optional)

Workspace tokens are defaults used by all team members until they set their
own personal tokens in My Settings. Add them to your `.env`:

```env
SKOPIX_SECRET_KEY=...

# LLM provider - pick one
GEMINI_API_KEY=AIza...

# Issue tracker (whichever you use)
GITHUB_TOKEN=ghp_...
GITHUB_REPO=yourorg/your-app

JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_PROJECT_KEY=PROJ

LINEAR_API_KEY=lin_api_...
```

And reference them in `docker-compose.yml`:
```yaml
services:
  skopix:
    environment:
      SKOPIX_SECRET_KEY: ${SKOPIX_SECRET_KEY}
      SKOPIX_TEAM_MODE: "true"
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITHUB_REPO: ${GITHUB_REPO}
```

These are the **workspace defaults**. Individual users can set their own
GitHub token / API keys in the dashboard which override these for their own
test runs. See the Per-user tokens section of the landing page for more.

---

## Backup and restore

Everything Skopix persists lives in `./skopix-data` (or wherever you mounted
the `/data` volume). Back it up = back up Skopix entirely.

**What's in there:**
```
skopix-data/
├── db/
│   ├── skopix.db          # users, sessions, encrypted tokens, audit log
│   └── credentials.yaml   # credentials vault
├── reports/               # test reports, videos, screenshots, runBy metadata
└── suites/                # *.suite.yaml files (your test definitions)
                           # plus .skopix.env if you put workspace tokens there
```

**Backup (live container, no downtime):**
```bash
tar czf skopix-backup-$(date +%Y%m%d).tar.gz skopix-data/
```

For a fully-consistent backup, stop Skopix first:
```bash
docker compose down
tar czf skopix-backup-$(date +%Y%m%d).tar.gz skopix-data/
docker compose up -d
```

**Restore on a new server:**
```bash
# On the new server, in the same directory layout:
tar xzf skopix-backup-20250101.tar.gz
# Set the SAME SKOPIX_SECRET_KEY in .env that you used originally
docker compose up -d
```

**Don't forget:** restore needs the **same `SKOPIX_SECRET_KEY`** as the original.
If you lose the key, you lose all encrypted per-user tokens (user accounts and
suites still work fine - those aren't encrypted with the secret key).

---

## Updating Skopix

```bash
cd ~/skopix
docker compose pull
docker compose up -d
```

That fetches the latest image and recreates the container with it. Data in
`./skopix-data` is preserved.

If something breaks after updating, you can roll back to a specific version:
```bash
# Edit docker-compose.yml - change the image tag from :latest to a specific version
# e.g. image: ghcr.io/x444dyx/skopix:1.0.0
docker compose pull
docker compose up -d
```

Available tags are listed on the [GitHub Container Registry
page](https://github.com/x444dyx/skopix/pkgs/container/skopix).

---

## Reset / start over

Wipes ALL Skopix data. Useful if you've been testing and want to start fresh.

```bash
docker compose down
rm -rf ./skopix-data
docker compose up -d
```

Then visit `/setup` and create the admin account again.

---

## Architecture support

The image is built for both:
- **linux/amd64** — x86_64 (most cloud VMs, Intel/AMD Macs, Linux desktops)
- **linux/arm64** — ARM64 (Apple Silicon Macs, Raspberry Pi 4/5, AWS Graviton,
  Hetzner Ampere)

Docker pulls the right one automatically based on your host's architecture. You
don't need to specify.

---

## Troubleshooting

### Container starts but I can't reach it

Check the container is actually running:
```bash
docker ps
```

If it shows as `Restarting` or stopped, check logs:
```bash
docker logs skopix
```

Common causes:
- **Missing or short `SKOPIX_SECRET_KEY`** in team mode — entrypoint fails fast
  with a clear message
- **Port 9000 already in use** on the host — change `9000:9000` to a different
  left-side port (e.g. `8080:9000`)
- **`./skopix-data` not writable** — check directory permissions

### Caddy can't get a certificate

Visit `https://skopix.yourcompany.com` and you get a cert error. Check:
```bash
docker compose logs caddy
```

Common causes:
- DNS not propagated yet — wait, or check `dig skopix.yourcompany.com`
- Ports 80/443 blocked by your hosting firewall — UFW/iptables/cloud security group
- Rate-limited by Let's Encrypt — happens if you've created many certs for the
  same domain recently. Wait or use staging endpoint via `acme_ca` directive.

### Stored tokens stopped working

Most likely cause: `SKOPIX_SECRET_KEY` changed between runs. The encrypted user
secrets in `skopix.db` can only be decrypted with the original key. Either
restore the original key or have users re-enter their tokens in My Settings.

### Out of memory

Chromium is memory-hungry. Each running test uses 200-500MB. For a server
running tests in parallel, plan on at least 2GB of RAM. 4GB is comfortable.

### Container logs are noisy

Most lines you see during a test run are normal Skopix progress output. Errors
are prefixed with `✗` or `Error:`. To see only errors:
```bash
docker logs skopix 2>&1 | grep -E '(✗|Error|FATAL)'
```

---

## Why these choices

A few things in the Docker setup that might puzzle you:

- **`mcr.microsoft.com/playwright` base image** rather than `node:20-slim`: the
  Playwright base image ships with Chromium and all its shared libraries
  pre-installed. Building from `node:20-slim` would require ~30 lines of
  `apt-get install` for libnss3, libxkbcommon, etc. — and is a constant source
  of "Chromium can't start" headaches as system libraries shift between releases.

- **`pwuser` non-root user**: Chromium technically refuses to run as root by
  default. We could pass `--no-sandbox` but that disables process sandboxing,
  which is a security regression. Running as `pwuser` (which the Playwright
  image creates for exactly this) keeps the sandbox enabled.

- **Single `/data` mount**: rather than separate mounts for db, reports, and
  suites. One folder to back up. One folder to migrate. The entrypoint
  symlinks the right subdirs into the locations Skopix expects.

- **Multi-stage build**: keeps the final image small by leaving build tools
  (npm cache, gcc, etc.) in the deps stage.

- **Caddy over nginx**: nginx is great but auto-HTTPS requires `certbot` + cron
  + manual config. Caddy does it in 3 lines of config with one command. The
  trade-off is nginx is more familiar to ops people; Caddy is friendlier to
  developers. For a single-service setup like this, Caddy wins.
