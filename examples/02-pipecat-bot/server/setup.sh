#!/usr/bin/env bash
# Fetch and install the upstream lipsync bot server.
#
# Not vendored: the analyzer is a separate project with its own release
# cadence, and pinning a copy here would drift from the wire format it
# defines.
set -euo pipefail

# Our fork of jptaylor/pipecat-visemes. The fork's main mirrors upstream; this
# branch adds analyzer fixes measured with its accuracy benchmark (close vowels
# no longer read as nasal murmurs, vowel-identity scoring) and the
# text-informed tier enabled in bot.py.
REPO="https://github.com/maxipesfix/pipecat-visemes.git"
BRANCH="fix/vowel-rounding"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vendor"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating $DIR"
  # Clones made before the switch to the fork still point at upstream, and
  # clones of the fork's main track only main.
  git -C "$DIR" remote set-url origin "$REPO"
  git -C "$DIR" fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"
  if git -C "$DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$DIR" switch "$BRANCH"
    git -C "$DIR" merge --ff-only "origin/$BRANCH"
  else
    git -C "$DIR" switch -c "$BRANCH" "origin/$BRANCH"
  fi
else
  echo "==> Cloning $REPO ($BRANCH)"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
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
