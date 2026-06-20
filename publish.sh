#!/usr/bin/env bash
#
# publish.sh — cut a new release of pi-smart-web-search.
#
# In plain terms: it bumps the version, pushes the change, and creates a GitHub
# Release. Creating the Release is what tells GitHub Actions to publish the
# package to npm (via trusted publishing) — so this script never runs
# `npm publish` itself, and never needs a token.
#
# Usage:
#   ./publish.sh          # patch release: 0.2.1 -> 0.2.2  (the default)
#   ./publish.sh minor    # new features:  0.2.1 -> 0.3.0
#   ./publish.sh major    # breaking:      0.2.1 -> 1.0.0
#
set -euo pipefail

# Which kind of release? Read it from the first argument, defaulting to "patch"
# — the smallest, safest, most common bump (bug fixes, docs).
bump="${1:-patch}"
case "$bump" in
  patch | minor | major) ;;
  *)
    echo "usage: $0 [patch|minor|major]" >&2
    exit 1
    ;;
esac

# Refuse to release unless we're on main — it's the branch the publish workflow
# runs on and the one npm is configured to trust.
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || {
  echo "error: on '$branch' — releases happen from 'main'" >&2
  exit 1
}

# Refuse to release with uncommitted changes, so the published version is
# exactly what's committed — no surprises slipped in.
[ -z "$(git status --porcelain)" ] || {
  echo "error: working tree is dirty — commit or stash first" >&2
  exit 1
}

# Make sure local main matches GitHub, so we can't release stale code or forget
# to push something.
git fetch --quiet origin main
[ "$(git rev-parse @)" = "$(git rev-parse '@{u}')" ] || {
  echo "error: local main is not in sync with origin/main" >&2
  exit 1
}

# Run the full quality gate (types, lint, format, spelling, tests). If anything
# is red we stop here — a broken build never gets tagged or released.
echo "Running checks..."
npm run check

# Bump the version in package.json, commit it, and create the matching git tag.
# `npm version` prints the new tag (e.g. "v0.2.2"), which we capture to name the
# Release below — no need to parse package.json.
echo "Bumping ($bump)..."
tag="$(npm version "$bump")"

# Push the version commit and its tag up to GitHub.
echo "Pushing $tag..."
git push --follow-tags

# Create the GitHub Release. This is the trigger: publishing a Release starts
# the publish workflow, which publishes to npm with provenance — automatically.
echo "Creating GitHub Release $tag..."
gh release create "$tag" --generate-notes

# Done. The npm publish is now running on its own.
echo "Released $tag. The publish is running on GitHub — watch it with:  gh run watch"
