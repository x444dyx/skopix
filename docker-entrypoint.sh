#!/bin/bash
# ===== Skopix Docker entrypoint =====
#
# Starts as root, prepares the /data volume (subdirs, permissions, symlinks),
# validates env vars, then drops to pwuser (Playwright's non-root user) and
# exec's the Skopix CLI.

set -e

# ----- Config -----
DATA_DIR="${SKOPIX_DATA_DIR:-/data}"
APP_USER="pwuser"

# Determine the actual home dir for pwuser. We can't assume /home/pwuser since
# it varies between Playwright base image versions and is sometimes missing.
# Read it from /etc/passwd directly.
PWUSER_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)
if [ -z "$PWUSER_HOME" ]; then
  # Fall back to /home/pwuser and create it if needed
  PWUSER_HOME="/home/$APP_USER"
fi

# Ensure pwuser's home actually exists - the dir is sometimes listed in passwd
# without ever being created.
mkdir -p "$PWUSER_HOME"

# Banner
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Skopix Docker container starting"
echo " Data dir:    $DATA_DIR"
echo " Run as:      $APP_USER (home: $PWUSER_HOME)"
echo " Team mode:   ${SKOPIX_TEAM_MODE:-false}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ----- Validate env in team mode -----
if [ "${SKOPIX_TEAM_MODE:-false}" = "true" ]; then
  if [ -z "$SKOPIX_SECRET_KEY" ]; then
    echo ""
    echo "  ✗ ERROR: SKOPIX_SECRET_KEY is required in team mode"
    echo ""
    echo "  Generate one with:  openssl rand -base64 32"
    echo "  Pass to Docker:     -e SKOPIX_SECRET_KEY=\"...\""
    echo ""
    exit 1
  fi
  if [ ${#SKOPIX_SECRET_KEY} -lt 16 ]; then
    echo ""
    echo "  ✗ ERROR: SKOPIX_SECRET_KEY must be at least 16 characters long"
    echo "  Current length: ${#SKOPIX_SECRET_KEY}"
    echo ""
    exit 1
  fi
fi

# ----- Prepare data volume -----
mkdir -p "$DATA_DIR/db"
mkdir -p "$DATA_DIR/reports"
mkdir -p "$DATA_DIR/suites"

# Migrate any pre-existing DB/creds from the wrong home location (left by previous
# buggy entrypoint versions that wrote to /root/.skopix as root)
if [ -d "/root/.skopix" ] && [ ! -L "/root/.skopix" ]; then
  [ -f "/root/.skopix/skopix.db" ] && mv "/root/.skopix/skopix.db" "$DATA_DIR/db/skopix.db" 2>/dev/null || true
  [ -f "/root/.skopix/credentials.yaml" ] && mv "/root/.skopix/credentials.yaml" "$DATA_DIR/db/credentials.yaml" 2>/dev/null || true
  rm -rf "/root/.skopix"
fi

# Same for pwuser's home (in case a previous run set something up wrong there)
if [ -d "$PWUSER_HOME/.skopix" ] && [ ! -L "$PWUSER_HOME/.skopix" ]; then
  [ -f "$PWUSER_HOME/.skopix/skopix.db" ] && mv "$PWUSER_HOME/.skopix/skopix.db" "$DATA_DIR/db/skopix.db" 2>/dev/null || true
  [ -f "$PWUSER_HOME/.skopix/credentials.yaml" ] && mv "$PWUSER_HOME/.skopix/credentials.yaml" "$DATA_DIR/db/credentials.yaml" 2>/dev/null || true
  rm -rf "$PWUSER_HOME/.skopix"
fi

# Symlink ~/.skopix -> /data/db (the central data location)
ln -sfn "$DATA_DIR/db" "$PWUSER_HOME/.skopix"

# Symlinks inside /data/suites so Skopix finds reports + env from its cwd
ln -sfn "$DATA_DIR/reports" "$DATA_DIR/suites/skopix-reports"
if [ -f "$DATA_DIR/.skopix.env" ]; then
  ln -sfn "$DATA_DIR/.skopix.env" "$DATA_DIR/suites/.skopix.env"
fi

# Fix permissions - pwuser needs to read/write everything under /data AND its home dir
# (the home is where ~/.skopix symlink lives)
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" 2>/dev/null || true
chown -R "$APP_USER:$APP_USER" "$PWUSER_HOME" 2>/dev/null || true

# ----- Decide what to run -----
COMMAND="${1:-dashboard}"
shift || true

case "$COMMAND" in
  dashboard)
    EXTRA_FLAGS="--host 0.0.0.0 --no-open"
    if [ "${SKOPIX_TEAM_MODE:-false}" = "true" ]; then
      EXTRA_FLAGS="$EXTRA_FLAGS --team"
    fi
    FULL_CMD="node /app/cli/index.js dashboard $EXTRA_FLAGS $@"
    ;;
  *)
    FULL_CMD="node /app/cli/index.js $COMMAND $@"
    ;;
esac

echo "  Working dir: $DATA_DIR/suites"
echo "  Command:     $FULL_CMD"
echo ""

# Drop privileges. The critical fix: we EXPLICITLY set HOME inside the su command
# rather than relying on `su -p` to preserve it. Different su versions / pam configs
# handle this differently, and on the Playwright base image the implicit HOME
# resolution was breaking - Skopix was seeing HOME=/root and trying to mkdir
# /root/.skopix which pwuser can't write to.
exec su -p "$APP_USER" -s /bin/bash -c "export HOME='$PWUSER_HOME' && cd '$DATA_DIR/suites' && $FULL_CMD"
