#!/usr/bin/env bash
# Run the mbb-consultant gate suite.
#
# WHY A RUNNER. Both harnesses live in lumid_ui/e2e but import `playwright`,
# which resolves only here -- so from their own directory neither could start.
# They were also wired into nothing: no CI job, no npm script, no reference
# anywhere. "Tier 3 and Tier 4 have never run" was not an oversight, there was
# no way to run them.
#
# It also bridges the credential names: .env.local carries E2E_ADMIN_*, the
# harnesses read LUMID_*. That mismatch alone would send a run down the PAT
# path, where the SPA's cookie-reading auth guard bounces it to /auth/login and
# every conversation gate is skipped with a note rather than failing -- a green
# run that proved nothing.
#
#   ./run-mbb-gates.sh            # gate suite (asserts, exit 1 on failure)
#   ./run-mbb-gates.sh --walk     # fresh-user UX walk (observational, always 0)
#
# Env passthrough: APP, CASE, LUMID_BASE.
set -uo pipefail
cd "$(dirname "$0")"

[ -f .env.local ] && set -a && . ./.env.local && set +a

# The harnesses import `playwright` by bare specifier, and ESM resolves that
# from the IMPORTING file's directory -- not cwd, and not NODE_PATH, which is
# CommonJS-only. lumid_ui/e2e/node_modules was a symlink to
# /tmp/uidrive/node_modules dated 8 July: /tmp is scratch, so the link was dead
# and both harnesses threw ERR_MODULE_NOT_FOUND before running a line. That is
# the actual reason "tier 3 and tier 4 have never run".
#
# Repoint it here rather than only by hand, so the fix survives a fresh machine
# instead of rotting the same way.
GATE_MODULES=../lumid_ui/e2e/node_modules
if [ ! -e "$GATE_MODULES/playwright" ]; then
  echo "run-mbb-gates: (re)pointing $GATE_MODULES at $PWD/node_modules"
  rm -f "$GATE_MODULES"
  ln -sfn "$PWD/node_modules" "$GATE_MODULES"
fi

: "${LUMID_EMAIL:=${E2E_ADMIN_EMAIL:-}}"
: "${LUMID_PASSWORD:=${E2E_ADMIN_PASSWORD:-}}"
export LUMID_EMAIL LUMID_PASSWORD
export NODE_PATH="$PWD/node_modules${NODE_PATH:+:$NODE_PATH}"

if [ -z "$LUMID_PASSWORD" ]; then
  # Refuse rather than degrade. A PAT run exercises the API plane but cannot
  # render Studio, so it would report mostly-passing while testing half the app.
  echo "run-mbb-gates: no password. Set E2E_ADMIN_PASSWORD in .env.local (or LUMID_PASSWORD)." >&2
  echo "  A PAT-only run cannot reach the SPA and would pass without testing the render plane." >&2
  exit 2
fi

SCRIPT=../lumid_ui/e2e/studio-mbb-consultant.mjs
[ "${1:-}" = "--walk" ] && SCRIPT=../lumid_ui/e2e/fresh-user-mbb.mjs

echo "run-mbb-gates: $SCRIPT as ${LUMID_EMAIL} against ${LUMID_BASE:-https://lum.id}"
exec node "$SCRIPT"
