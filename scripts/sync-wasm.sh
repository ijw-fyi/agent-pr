#!/bin/bash
# Single source of truth for tree-sitter WASM files
# Update this list when adding new language support

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASM_DIR="$PROJECT_ROOT/src/helpers/wasm"

# === ADD NEW LANGUAGES HERE ===
# Format: "npm-package-path:output-filename"
WASM_FILES=(
    "tree-sitter-typescript/tree-sitter-typescript.wasm"
    "tree-sitter-typescript/tree-sitter-tsx.wasm"
    "tree-sitter-javascript/tree-sitter-javascript.wasm"
    "tree-sitter-python/tree-sitter-python.wasm"
    "tree-sitter-c/tree-sitter-c.wasm"
    "tree-sitter-cpp/tree-sitter-cpp.wasm"
)
# ==============================

mkdir -p "$WASM_DIR"

for wasm in "${WASM_FILES[@]}"; do
    src="$PROJECT_ROOT/node_modules/$wasm"
    if [[ -f "$src" ]]; then
        cp "$src" "$WASM_DIR/"
    else
        echo "Warning: $src not found" >&2
    fi
done
