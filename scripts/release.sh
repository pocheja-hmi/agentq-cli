#!/usr/bin/env bash
# Release a new version of agentq-cli.
#
# Usage:
#     scripts/release.sh <vX.Y.Z>           # do it
#     scripts/release.sh <vX.Y.Z> --dry-run # show what would happen
#
# What this does, in order:
#     1. Validates the working tree is clean.
#     2. Validates the version string is semver (vMAJOR.MINOR.PATCH).
#     3. Refuses if the EXACT tag already exists locally or remotely.
#     4. Refuses if a bare `vMAJOR` TAG exists on remote — that's the footgun
#        the agentq-actions migration ran into. `vMAJOR` must be a BRANCH.
#     5. Bumps package.json version to X.Y.Z (without auto-tagging, we do
#        the tagging ourselves with the right refspecs).
#     6. Runs `npm run lint` + `npm run build` as a pre-release gate. If
#        either fails, reverts the package.json bump and aborts.
#     7. Commits the package.json bump.
#     8. Creates the exact tag `vX.Y.Z` at HEAD.
#     9. Moves the floating major-version BRANCH `vMAJOR` to point at the tag.
#    10. Pushes everything with EXPLICIT refspecs (no ambiguity).
#
# Consumers install via:
#     npm install -g github:HorizonMedia/agentq-cli#v1          # floating major
#     npm install -g github:HorizonMedia/agentq-cli#v1.0.2      # exact version
#
# The `prepare` hook in package.json runs `npm run build` during install,
# so consumers always get a freshly compiled CLI for the ref they pinned.
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <vX.Y.Z> [--dry-run]" >&2
    exit 2
fi

VERSION="$1"
DRY_RUN=false
if [[ "${2:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

# ─── Validate version format ─────────────────────────────────────────────────
if [[ ! "$VERSION" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR: version must match vMAJOR.MINOR.PATCH (e.g. v0.2.0). Got: '$VERSION'" >&2
    exit 2
fi
MAJOR_NUM="${BASH_REMATCH[1]}"
MAJOR="v${MAJOR_NUM}"
NPM_VERSION="${VERSION#v}"

# Move to repo root regardless of where the script is invoked from.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

run() {
    local label="$1"; shift
    if $DRY_RUN; then
        echo "  [DRY] $label"
        echo "        $ $*"
    else
        echo "  $label"
        "$@"
    fi
}

echo
echo "Releasing agentq-cli $VERSION (npm version: $NPM_VERSION, major branch: $MAJOR)"
$DRY_RUN && echo "[DRY RUN — no changes will be pushed]"
echo

# ─── Working tree must be clean ──────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: working tree has uncommitted changes. Commit or stash first." >&2
    git status --short >&2
    exit 1
fi

# ─── Refuse if exact tag already exists ──────────────────────────────────────
if git rev-parse --verify --quiet "refs/tags/$VERSION" >/dev/null; then
    echo "ERROR: tag $VERSION already exists locally. Delete it first if this is intentional." >&2
    exit 1
fi
git fetch --tags --quiet origin
if git rev-parse --verify --quiet "refs/tags/$VERSION" >/dev/null; then
    echo "ERROR: tag $VERSION already exists on origin. Pick the next patch version." >&2
    exit 1
fi

# ─── Refuse if a bare `vMAJOR` TAG exists on remote ──────────────────────────
# `vMAJOR` is a BRANCH that floats forward. A same-named tag makes
# `git push origin vMAJOR` ambiguous and breaks consumers' `@vMAJOR` pins.
if git ls-remote --exit-code --tags origin "refs/tags/$MAJOR" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: a tag named '$MAJOR' exists on origin. The convention is that
'$MAJOR' is a BRANCH that floats forward; a tag with the same name causes
'git push origin $MAJOR' to be ambiguous. Delete the tag first:

    git push origin --delete refs/tags/$MAJOR

Then re-run this script.
EOF
    exit 1
fi

# ─── Bump package.json version (no auto-tagging — we do that step ourselves) ─
# Rollback-on-failure: if any subsequent step blows up, restore the original
# package.json so the working tree is back to the pre-release state.
# Using `npm pkg set` keeps the file's existing key order intact (npm version
# also works fine but emits its own console chatter we don't need).
ORIGINAL_VERSION="$(node -p 'require("./package.json").version')"
cleanup_failed_bump() {
    if [[ "$(node -p 'require("./package.json").version' 2>/dev/null)" != "$ORIGINAL_VERSION" ]]; then
        echo "  ↪ reverting package.json to $ORIGINAL_VERSION"
        npm pkg set "version=$ORIGINAL_VERSION" >/dev/null
    fi
}
trap cleanup_failed_bump ERR

run "bump package.json version to $NPM_VERSION" \
    npm pkg set "version=$NPM_VERSION"

# ─── Pre-release gate: lint + build ──────────────────────────────────────────
# If either fails, the ERR trap reverts package.json before the script exits.
run "lint (tsc --noEmit)" \
    npm run lint

run "build (tsc)" \
    npm run build

# ─── Verify dist/ is fresh and committed ─────────────────────────────────────
# Consumers install via `npm install -g github:.../#vX.Y.Z` which does NOT
# run tsc. Whatever's in dist/ at the tag IS what they get. If src/ changed
# without dist/ being rebuilt, the published CLI silently keeps old behavior.
# This guard refuses to tag in that state.
if ! $DRY_RUN; then
    if ! git diff --quiet -- dist/; then
        echo "ERROR: dist/ has uncommitted changes after build — the previous commit's"
        echo "       dist/ is stale relative to src/. Commit the regenerated dist/ first:" >&2
        echo "         git add dist/ && git commit -m 'rebuild dist/'" >&2
        echo "       Then re-run this release." >&2
        # Build already happened; src/ wasn't mutated, so reverting package.json is enough.
        cleanup_failed_bump
        exit 1
    fi
fi

# Once we get past the gate, the release is in good shape; disable the trap so
# we don't accidentally revert package.json when committing.
trap - ERR

# ─── Commit the bump (only package.json should be dirty) ─────────────────────
if ! $DRY_RUN; then
    if [[ -z "$(git status --porcelain package.json)" ]]; then
        echo "ERROR: expected package.json to be modified by the bump step but it isn't." >&2
        exit 1
    fi
    if [[ -n "$(git status --porcelain | grep -v '^.M package.json$' | grep -v '^ M package.json$')" ]]; then
        echo "ERROR: unexpected files modified after bump. Aborting." >&2
        git status --short >&2
        exit 1
    fi
fi

run "commit version bump" \
    git commit -am "Release $VERSION"

# ─── Tag, move major branch, push ────────────────────────────────────────────
run "create tag $VERSION at HEAD" \
    git tag -a "$VERSION" -m "Release $VERSION"

# Push the release commit first, then the tag, then the floating branch.
run "push main" \
    git push origin "HEAD:refs/heads/main"

run "push tag $VERSION" \
    git push origin "refs/tags/$VERSION:refs/tags/$VERSION"

run "move local branch $MAJOR to $VERSION" \
    git branch -f "$MAJOR" "$VERSION"

run "force-push branch $MAJOR" \
    git push -f origin "refs/heads/$MAJOR:refs/heads/$MAJOR"

echo
if $DRY_RUN; then
    echo "✓ Dry run complete. No changes pushed."
    # Restore package.json since the bump was performed (it's not in dry-run guard).
    if [[ "$(node -p 'require("./package.json").version' 2>/dev/null)" != "$ORIGINAL_VERSION" ]]; then
        npm pkg set "version=$ORIGINAL_VERSION" >/dev/null
        echo "  (package.json reverted to $ORIGINAL_VERSION)"
    fi
    exit 0
fi

echo "Verifying remote state..."
git ls-remote origin "refs/heads/main" "refs/heads/$MAJOR" "refs/tags/$VERSION" "refs/tags/$MAJOR" \
    | awk '
        NF == 2 {
            ref=$2; sha=$1
            printf "  %-30s %s\n", ref, sha
        }
    '

if git ls-remote --exit-code --tags origin "refs/tags/$MAJOR" >/dev/null 2>&1; then
    echo "::warning::Bare '$MAJOR' tag is present on origin. Delete it manually." >&2
fi

cat <<EOF

✓ agentq-cli $VERSION published.

  Consumers install:
      npm install -g github:HorizonMedia/agentq-cli#${MAJOR}       # floating
      npm install -g github:HorizonMedia/agentq-cli#${VERSION}    # pinned

  Don't forget to:
    - Update CHANGELOG.md if you haven't already
    - Open a GitHub Release: gh release create ${VERSION} --notes-from-tag
    - Bump the cli_version default in agentq-actions if this is a recommended
      pin for new scaffolds (currently in scaffolded workflows + actions/setup).
EOF
