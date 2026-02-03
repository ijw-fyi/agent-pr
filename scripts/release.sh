#!/bin/bash
# Release script for pr-review-agent
# Syncs WASM files, builds the action, and creates a new release

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASM_DIR="$PROJECT_ROOT/src/helpers/wasm"
ACTION_DIR="$PROJECT_ROOT/action"

cd "$PROJECT_ROOT"

echo "=== PR Review Agent Release Script ==="
echo ""

# Step 1: Sync WASM files from node_modules
echo "📦 Syncing tree-sitter WASM files from node_modules..."
"$SCRIPT_DIR/sync-wasm.sh"
echo "   ✓ WASM files synced"

# Step 2: Clean previous build
echo "🧹 Cleaning previous build..."
rm -rf "$ACTION_DIR"
echo "   ✓ Cleaned action directory"

# Step 3: Compile TypeScript
echo "🔨 Compiling TypeScript..."
yarn tsc
echo "   ✓ TypeScript compiled"

# Step 4: Bundle with ncc
echo "📦 Bundling with ncc..."
yarn ncc build dist/index.js -o action -e web-tree-sitter
rm -rf "$ACTION_DIR/web-tree-sitter"
echo "   ✓ Bundle created"

# Step 5: Copy WASM and web-tree-sitter runtime
echo "📋 Copying WASM files and web-tree-sitter runtime..."
mkdir -p "$ACTION_DIR/wasm" "$ACTION_DIR/node_modules/web-tree-sitter"

cp "$WASM_DIR"/* "$ACTION_DIR/wasm/"
cp node_modules/web-tree-sitter/web-tree-sitter.js \
   node_modules/web-tree-sitter/web-tree-sitter.wasm \
   node_modules/web-tree-sitter/package.json \
   "$ACTION_DIR/node_modules/web-tree-sitter/"

echo "   ✓ Runtime files copied"

# Step 6: Stage action directory
echo "📝 Staging action directory..."
git add action/
echo "   ✓ Staged"

# Step 7: Version bump (interactive)
echo ""
echo "🏷️  Bumping version..."
yarn version

# Step 8: Push
echo "🚀 Pushing to remote..."
git push && git push --tags

echo ""
echo "=== Release complete! ==="
