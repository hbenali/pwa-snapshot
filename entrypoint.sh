#!/bin/sh
# Fix /output write permissions at runtime.
# The container starts as root so we can chown the mounted volume dir,
# then drop to uid 1001 (snapshot) for the actual work.
chown -R 1001:1001 /output 2>/dev/null || true
exec su-exec 1001:1001 node /app/src/cli.js "$@"