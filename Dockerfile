# ===== Skopix Dockerfile =====
# Multi-stage build for a lean production image with Playwright + Chromium baked in.
#
# Base: Microsoft's official Playwright image. It comes with:
#  - Ubuntu 22.04 (jammy)
#  - Node.js 20
#  - Chromium + Firefox + WebKit pre-installed at /ms-playwright
#  - All the shared libraries Chromium needs (libnss3, libxkbcommon, etc.)
# That single decision saves us hundreds of lines of apt-get installs and
# "why does Chromium segfault" debugging.
#
# We pin to a specific Playwright version. When upgrading the Playwright npm
# dependency in package.json, bump this tag to match (the major+minor must agree
# or browser binaries and the npm client get out of sync and tests fail weirdly).

# ----- Stage 1: build dependencies -----
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS deps

WORKDIR /app

# Install ffmpeg in deps stage so the layer is cached even when package.json changes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy only what's needed for npm install. Doing this BEFORE the rest of the
# source means Docker reuses node_modules across rebuilds when only source changes.
COPY package.json package-lock.json* ./

# Browsers are already at /ms-playwright in the base image - skip the download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Production deps only. better-sqlite3 (optionalDependency) compiles natively here -
# Playwright base has python3/make/g++ already so it works without extra installs.
RUN npm install --omit=dev --no-audit --no-fund

# ----- Stage 2: runtime image -----
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from the deps stage. Final image stays small because
# we don't carry npm/build tooling around.
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY . .

# Make the entrypoint script executable
RUN chmod +x /app/docker-entrypoint.sh

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Skopix persists everything under /data - mount this as a volume.
# Subdirs (db/, reports/, suites/) are created on first run by entrypoint.
VOLUME ["/data"]

# Dashboard port
EXPOSE 9000

ENV NODE_ENV=production
ENV SKOPIX_DATA_DIR=/data

# Entry runs as root (default) to chown the mounted /data, then drops to pwuser
# (Playwright's non-root user) before exec'ing Skopix. See docker-entrypoint.sh.

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["dashboard"]
