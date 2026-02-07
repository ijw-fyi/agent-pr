# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-powered GitHub Action that reviews pull requests using a LangChain ReAct agent loop. Triggered by commenting `/review` on any PR. Uses OpenRouter for LLM access and supports MCP for extensible tooling.

## Commands

- `yarn build` — Full production build (syncs WASM, compiles TS, bundles with ncc to `action/`)
- `yarn dev` — Run locally with tsx: `tsx src/index.ts`
- `yarn typecheck` — Type-check without emitting: `tsc --noEmit`
- `yarn sync-wasm` — Copy tree-sitter WASM files from node_modules to `src/helpers/wasm/`

No test framework is configured. There are no lint or format commands.

## Architecture

### Two Operating Modes

Dispatched from `src/index.ts` based on `ACTION_MODE` env var:

1. **Review mode** (`ACTION_MODE=review`) — `src/agents/review/index.ts`
   - Triggered by `/review` comment on a PR
   - Runs a 3-phase ReAct agent: triage → investigation → submit review
   - Uses tools to read files, grep, leave inline comments, and submit a final verdict

2. **Comment reply mode** (`ACTION_MODE=comment-reply`) — `src/agents/comment-reply/index.ts`
   - Triggered by replies to the bot's review comments
   - Extracts coding preferences and stores them on a `__agent_pr__` orphan branch

### Key Modules

- **`src/context/github.ts`** — All GitHub API interactions via Octokit (fetch PR data, post comments, submit reviews, read/write preferences branch)
- **`src/context/types.ts`** — Core interfaces: `PRContext`, `ReviewComment`, `PRFile`, etc.
- **`src/tools/`** — LangChain tool implementations. Each tool exports a `tool()` call with a Zod schema. Tool names use snake_case (e.g., `read_files`, `leave_comment`)
- **`src/tools/index.ts`** — Tool registry; builds the tool array and accepts MCP tools dynamically
- **`src/helpers/cached-model.ts`** — OpenRouter client with prompt caching support, cost/token tracking
- **`src/helpers/overrides.ts`** — Parses `/review` command flags (`--budget`, `--model`, `--recursion-limit`, `--max-loc`)
- **`src/helpers/tree-sitter.ts`** — Web Tree Sitter parser for symbol extraction (TS, JS, Python, C, C++)
- **`src/mcp/`** — MCP client for connecting to HTTP/stdio MCP servers (DeepWiki by default)
- **`src/preferences/git.ts`** — Preference storage on `__agent_pr__` orphan branch via GitHub API

### Runtime Context

Tools access runtime context through `process.env` variables: `REPO_OWNER`, `REPO_NAME`, `PR_NUMBER`, `HEAD_SHA`, `MODEL`, `OPENROUTER_KEY`, `GITHUB_TOKEN`. These are set at startup from GitHub Actions environment.

### Build Pipeline

TypeScript compiles to `dist/`, then `@vercel/ncc` bundles everything into `action/index.js`. WASM files for tree-sitter are copied alongside the bundle.

## Code Conventions

- **ES Modules** with `"type": "module"` — imports use `.js` extensions (e.g., `import { foo } from "./bar.js"`)
- **Strict TypeScript** — `strict: true`, target ES2022, NodeNext module resolution
- **Tool definition pattern**: `tool(handler, { name, description, schema: z.object({...}) })` from `@langchain/core/tools`
- Interfaces use PascalCase; tool names use snake_case; functions use camelCase
- Tools return error strings instead of throwing on failure
