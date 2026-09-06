#!/usr/bin/env bash
# Fetch and install the upstream lipsync bot server.
#
# Not vendored: the analyzer is a separate project with its own release
# cadence, and pinning a copy here would drift from the wire format it
# defines.
set -euo pipefail

REPO="https://github.com/jptaylor/pipecat-visemes.git"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vendor"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "==> Cloning $REPO"
  git clone --depth 1 "$REPO" "$DIR"
fi

echo "==> Installing server dependencies"
(cd "$DIR/server" && uv sync)

cat <<'MSG'

Done. Next:

  cd vendor/server
  cp .env.example .env     # add DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY
  uv run bot.py            # serves on http://localhost:7860

Then, in another terminal, start the client:

  npm --prefix ../client install
  npm --prefix ../client run dev
MSG
