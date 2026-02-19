#!/usr/bin/env bash
set -euo pipefail

# Publish a new release of openclaw-mcp-adapter
# Usage: ./scripts/publish-release.sh [patch|minor|major]

BUMP="${1:-patch}"
REPO_URL="https://github.com/pandysp/openclaw-mcp-adapter"

# Ensure we're on main and clean
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Error: must be on main branch (currently on $BRANCH)"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working directory is not clean"
  exit 1
fi

# Pull latest
git pull --rebase

# Build
echo "Building..."
npm run clean
npm run build

# Bump version
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped to $NEW_VERSION"

# Commit and tag
git add package.json package-lock.json
git commit -m "release: $NEW_VERSION"
git tag "$NEW_VERSION"

echo ""
echo "Ready to publish! Run:"
echo "  git push origin main --tags"
echo ""
echo "This will trigger CI to publish to npm."
echo "Monitor at: $REPO_URL/actions"
