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
   - Runs a 4-phase ReAct agent: Phase 0 (re-review check) → triage → investigation → submit review
   - Uses tools to read files, grep, leave inline comments, and submit a final verdict
   - Includes duplicate review prevention — checks for existing bot reviews before submitting
   - Files can be excluded via `--ignore` glob patterns (uses `minimatch`)

2. **Comment reply mode** (`ACTION_MODE=comment-reply`) — `src/agents/comment-reply/index.ts`
   - Triggered in two cases:
     1. A user replies to one of the bot's review comments (automatic)
     2. A user writes `/question`, `/pr`, or `/reply` on any code line (even non-bot comments)
   - Answers the user's comment in-thread; does NOT perform a full PR review
   - Can extract coding preferences and store them on a `__agent_pr__` orphan branch
   - Does **not** have access to `leave_comment` or `submit_review` tools (review-only tools are filtered out)
   - Slash commands support override flags (e.g., `/question --model gpt-4 why is this async?`)

### Key Modules

- **`src/context/github.ts`** — All GitHub API interactions via Octokit (fetch PR data, post comments, submit reviews, read/write preferences branch)
- **`src/context/types.ts`** — Core interfaces: `PRContext`, `ReviewComment`, `PRFile`, `PRCommit`, `ReviewSummary`, etc.
- **`src/tools/`** — LangChain tool implementations. Each tool exports a `tool()` call with a Zod schema. Tool names use snake_case (e.g., `read_files`, `leave_comment`)
- **`src/tools/index.ts`** — Tool registry; builds the tool array and accepts MCP tools dynamically
- **`src/helpers/cached-model.ts`** — OpenRouter client with prompt caching support, cost/token tracking
- **`src/helpers/overrides.ts`** — Parses command flags (`--budget`, `--model`, `--recursion-limit`, `--max-loc`, `--ignore`) from `/review` and slash commands. `--ignore` is a multi-value flag (repeatable) joined with commas into `PR_AGENT_IGNORE`
- **`src/helpers/tree-sitter.ts`** — Web Tree Sitter parser for symbol extraction (TS, JS, Python, C, C++)
- **`src/mcp/`** — MCP client for connecting to HTTP/stdio MCP servers (DeepWiki by default)
- **`src/preferences/git.ts`** — Preference storage on `__agent_pr__` orphan branch via GitHub API

### Workflow Files

- **`/.github/workflows/pr-review.yml`** — Reference workflow bundled with this repo
- **External shared workflow** — https://github.com/ijw-fyi/.github-workflows/blob/main/.github/workflows/pr_review.yml — This is the workflow actually used by consuming repos via `workflow_call`. It sets `ACTION_MODE: preference` for the comment reply job (`pr_code_message`), which must be accepted as an alias for `comment-reply` in `src/index.ts`.

### Runtime Context

Tools access runtime context through `process.env` variables: `REPO_OWNER`, `REPO_NAME`, `PR_NUMBER`, `HEAD_SHA`, `MODEL`, `OPENROUTER_KEY`, `GITHUB_TOKEN`, `PR_AGENT_IGNORE`. These are set at startup from GitHub Actions environment.

`PRContext` includes `commits` (chronological list), `reviewSummaries` (bot's previous reviews), and `botLogin` (authenticated bot's GitHub username) for re-review awareness and duplicate prevention.

### Build Pipeline

TypeScript compiles to `dist/`, then `@vercel/ncc` bundles everything into `action/index.js`. WASM files for tree-sitter are copied alongside the bundle.

## Code Conventions

- **ES Modules** with `"type": "module"` — imports use `.js` extensions (e.g., `import { foo } from "./bar.js"`)
- **Strict TypeScript** — `strict: true`, target ES2022, NodeNext module resolution
- **Tool definition pattern**: `tool(handler, { name, description, schema: z.object({...}) })` from `@langchain/core/tools`
- Interfaces use PascalCase; tool names use snake_case; functions use camelCase
- Tools return error strings instead of throwing on failure
