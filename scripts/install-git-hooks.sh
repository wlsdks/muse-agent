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
# commit-msg: deterministic immutable-core guard (fail-close).
exec node "$(git rev-parse --show-toplevel)/scripts/guard-immutable.mjs" "$1"
EOF
chmod +x "$commit_hook"
echo "installed: $commit_hook -> scripts/guard-immutable.mjs"

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
exec pnpm -s precheck:grounding
EOF
chmod +x "$push_hook"
echo "installed: $push_hook -> precheck:grounding"
