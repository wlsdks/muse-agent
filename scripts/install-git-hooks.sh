#!/usr/bin/env bash
# Install Muse's git hooks. Idempotent; run once per clone (and after this
# commit lands on the loop PC). .git/hooks is not version-controlled, so this
# script IS the versioned source of truth for the hooks:
#   - commit-msg : deterministic immutable-core guard (fail-close).
#   - pre-push   : fabrication=0 grounding tripwire (precheck:grounding).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

commit_hook="$repo/.git/hooks/commit-msg"
cat > "$commit_hook" <<'EOF'
#!/usr/bin/env bash
# commit-msg: deterministic guards (fail-close) — immutable-core, then write-back.
root="$(git rev-parse --show-toplevel)"
node "$root/scripts/guard-immutable.mjs" "$1" || exit 1
exec node "$root/scripts/guard-writeback.mjs" "$1"
EOF
chmod +x "$commit_hook"
echo "installed: $commit_hook -> guard-immutable.mjs + guard-writeback.mjs"

push_hook="$repo/.git/hooks/pre-push"
cat > "$push_hook" <<'EOF'
#!/usr/bin/env bash
# pre-push: fabrication=0 grounding tripwire. Runs the fabrication-critical
# batteries live on the local model (pass^k). Skips itself when Ollama is
# unreachable or a battery stalls, so it never hard-blocks a model-less box;
# only a battery that RUNS and FAILS blocks the push. Genuine-emergency escape:
# MUSE_SKIP_PREPUSH=1 git push   (documented, greppable — prefer it to --no-verify).
if [ "${MUSE_SKIP_PREPUSH:-0}" = "1" ]; then
  echo "pre-push: grounding tripwire skipped (MUSE_SKIP_PREPUSH=1)"
  exit 0
fi
# Git GUI / IDE clients spawn hooks with a minimal PATH where a version-manager
# (corepack/nvm/volta) pnpm is absent. Resolve it; if it still can't be found,
# SKIP (fail-open on a broken hook environment) — never block a push because the
# tripwire couldn't even start. Run `pnpm precheck:grounding` manually to check.
if ! command -v pnpm >/dev/null 2>&1; then
  for d in "$HOME/.local/share/pnpm" "$HOME/Library/pnpm" "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -x "$d/pnpm" ] && PATH="$d:$PATH"
  done
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pre-push: pnpm not on PATH — grounding tripwire skipped (run 'pnpm precheck:grounding' manually to verify)"
  exit 0
fi
exec pnpm -s precheck:grounding
EOF
chmod +x "$push_hook"
echo "installed: $push_hook -> precheck:grounding"
