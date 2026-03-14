![banner](https://github.com/user-attachments/assets/8c1980e2-32a7-46fc-b0b4-176106d4a639)
# 🤖 PR Review Agent

AI-powered GitHub Action that reviews pull requests using an agentic loop. Triggered by commenting `/review` on any PR.

## Features

- **Agentic Review**: Uses LangChain's ReAct agent for iterative code analysis
- **Inline Comments**: Leaves targeted comments on specific lines of code
- **Preference Memory**: Learns your coding preferences from replies to review comments
- **MCP Support**: Extensible via Model Context Protocol (DeepWiki included by default)
- **Web Search**: Optional Gemini-powered web search for documentation lookup
- **Multi-Model**: Works with any model on OpenRouter (Claude, GPT-4, etc.)

## Quick Start

### 1. Add the workflow to your repository

Create `.github/workflows/pr-review.yml`:

#### Using shared workflow (recommended)
```yaml
name: PR Review

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  call-review:
    uses: ijw-fyi/agent-pr/.github/workflows/shared_workflow.yml@master
    secrets: inherit
```

<details>
<summary><strong>Full control</strong> (click to expand)</summary>

```yaml
name: PR Review

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    # Only run on PR comments that start with /review
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/review')
    runs-on: ubuntu-latest

    permissions:
      contents: read
      pull-requests: write
      issues: write

    steps:
      - name: Get PR details
        id: pr
        uses: actions/github-script@v7
        with:
          script: |
            const pr = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number
            });
            core.setOutput('head_sha', pr.data.head.sha);
            core.setOutput('base_sha', pr.data.base.sha);
            return pr.data;

      - name: Checkout PR head
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.head_sha }}
          fetch-depth: 0

      - name: Run PR Review Agent
        uses: ijw-fyi/agent-pr@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_KEY: ${{ secrets.OPENROUTER_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          MODEL: ${{ vars.PR_REVIEW_MODEL || 'anthropic/claude-opus-4.6' }}
          MCP_CONFIG: ${{ vars.MCP_CONFIG || '{"servers":[{"name":"deepwiki","transport":"http","url":"https://mcp.deepwiki.com/mcp"}]}' }}
          ACTION_MODE: review
          PR_NUMBER: ${{ github.event.issue.number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
          BASE_SHA: ${{ steps.pr.outputs.base_sha }}
          TRIGGER_COMMENT_ID: ${{ github.event.comment.id }}

  pr_comment_reply:
    # Run when someone replies to a review comment (not the initial /review command)
    if: github.event_name == 'pull_request_review_comment' && github.event.action == 'created'
    runs-on: ubuntu-latest

    permissions:
      contents: write  # Needed to create/update __agent_pr__ branch
      pull-requests: write  # Needed to leave notification comment

    steps:
      - name: Get PR details
        id: pr
        uses: actions/github-script@v7
        with:
          script: |
            const pr = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number
            });
            core.setOutput('head_sha', pr.data.head.sha);
            return pr.data;

      - name: Checkout PR head
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.head_sha }}

      - name: Run Comment Reply Agent
        uses: ijw-fyi/agent-pr@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_KEY: ${{ secrets.OPENROUTER_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          MODEL: ${{ vars.PR_REVIEW_MODEL || 'anthropic/claude-opus-4.6' }}
          MCP_CONFIG: ${{ vars.MCP_CONFIG || '{"servers":[{"name":"deepwiki","transport":"http","url":"https://mcp.deepwiki.com/mcp"}]}' }}
          ACTION_MODE: comment-reply
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          COMMENT_ID: ${{ github.event.comment.id }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
```

</details>

### 2. Add secrets to your repository or organization (For ORG level, this is a one time step)

Go to **Settings → Secrets and variables → Actions**:

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENROUTER_KEY` | ✅ Yes | Your [OpenRouter](https://openrouter.ai/) API key |
| `GEMINI_API_KEY` | ❌ No | Enables web search tool (Google AI) |

**Configuration** — set via workflow inputs (`with:`) or repo/org variables (Settings → Variables tab). Inputs take precedence over variables.

| Input / Variable | Default | Description |
|------------------|---------|-------------|
| `model` / `PR_REVIEW_MODEL` | `anthropic/claude-opus-4.6` | OpenRouter model identifier |
| `budget` / `AGENT_PR_BUDGET` | `2` | Cost budget in USD |
| `max_loc` / `PR_AGENT_MAX_LOC` | `2000` | Max diff lines of code to review |
| `review_mode` / `REVIEW_MODE` | `single` | Review strategy: `single` (one agent) or `orchestrated` (sub-agents for security, performance, code quality) |
| `mcp_config` / `MCP_CONFIG` | DeepWiki enabled | JSON config for MCP servers |

Example with workflow inputs:

```yaml
jobs:
  call-review:
    uses: ijw-fyi/agent-pr/.github/workflows/shared_workflow.yml@master
    with:
      model: "anthropic/claude-sonnet-4.5"
      budget: "5"
    secrets: inherit
```

### 3. Trigger a review

Comment `/review` on any pull request!

You can also pass inline overrides:

```
/review --budget 5 focus on security
/review --model opus check the database migrations
/review --budget 10 --max-loc 5000
/review --ignore "*.generated.ts" --ignore "migrations/*"
```

### 4. Ask questions or interact on code

Use slash commands on any code line in a PR to start a conversation:

```
/question why is this function async?
/pr what does this module do?
/reply I think we should use a different approach here
```

Replying to any bot review comment also triggers the comment-reply agent automatically.

## Command Overrides

Override configuration per-review by passing flags in your `/review` comment. Flags are stripped from the text before the agent sees it.

| Flag | Description | Example |
|------|-------------|---------|
| `--budget <n>` | Set cost budget in USD | `--budget 10` |
| `--model <name>` | Override the model | `--model opus` |
| `--recursion-limit <n>` | Max agent steps | `--recursion-limit 50` |
| `--max-loc <n>` | Max lines of code to review | `--max-loc 5000` |
| `--ignore <glob>` | Ignore files matching glob (repeatable) | `--ignore "migrations/*"` |

### Model Aliases

| Alias | Resolves to |
|-------|------------|
| `opus` | `anthropic/claude-opus-4.6` |
| `sonnet` | `anthropic/claude-sonnet-4.5` |
| `sonet` | `anthropic/claude-sonnet-4.5` |

Full OpenRouter model identifiers also work (e.g., `--model anthropic/claude-opus-4.6`).

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `anthropic/claude-opus-4.6` | OpenRouter model identifier (overridable via `--model`) |
| `AGENT_PR_BUDGET` | `2` | Cost budget in USD (overridable via `--budget`) |
| `RECURSION_LIMIT` | `100` | Max agent steps (overridable via `--recursion-limit`) |
| `PR_AGENT_MAX_LOC` | `2000` | Max diff LOC to review (overridable via `--max-loc`) |
| `PR_AGENT_IGNORE` | - | Comma-separated glob patterns to ignore (overridable via `--ignore`) |
| `REVIEW_MODE` | `single` | Review strategy: `single` or `orchestrated` |
| `MCP_CONFIG` | DeepWiki enabled | JSON config for MCP servers |
| `GEMINI_API_KEY` | - | Enables web search with Gemini |

### Model Selection

The default model is `anthropic/claude-opus-4.6`. We switched from Sonnet to Opus after finding that Opus produced significantly fewer false positives, used fewer tokens and agent steps to explore the codebase and reach the same conclusions, and required fewer re-runs — making it cheaper overall despite the higher per-token cost.

Any model available on [OpenRouter](https://openrouter.ai/models) works. Examples:

```yaml
MODEL: 'anthropic/claude-opus-4.6'  # Default — fewer false positives, cheaper overall
```

### MCP Servers

The action connects to MCP (Model Context Protocol) servers to extend capabilities. DeepWiki is included by default for querying GitHub repo documentation.

Custom configuration:

```yaml
MCP_CONFIG: |
  {
    "servers": [
      {"name": "deepwiki", "transport": "http", "url": "https://mcp.deepwiki.com/mcp"},
      {"name": "custom", "transport": "http", "url": "https://your-mcp-server.com/mcp"}
    ]
  }
```

## Review Modes

| Mode | `REVIEW_MODE` | Description | Best for |
|------|---------------|-------------|----------|
| **Single** | `single` (default) | One agent handles the entire review end-to-end | Most PRs, lower cost |
| **Orchestrated** | `orchestrated` | Three specialized sub-agents (security, performance, code quality) review in parallel, then a synthesizer submits a unified review | Large PRs, thorough domain-specific analysis |

To enable orchestrated mode, set the `REVIEW_MODE` variable to `orchestrated` in your repo/org settings (Settings → Variables → Actions), or pass it as a workflow input:

```yaml
jobs:
  call-review:
    uses: ijw-fyi/agent-pr/.github/workflows/shared_workflow.yml@[master]
    with:
      review_mode: "orchestrated"
    secrets: inherit
```

In orchestrated mode, three specialist agents run in parallel — each focused on its domain (🔒 security, ⚡ performance, 🧹 code quality). They leave inline comments independently, then a lightweight synthesizer combines their findings into a single review summary. This produces more thorough reviews but is slightly more expensive than single mode due to running multiple agents.

## What the Agent Reviews

The agent focuses on **significant issues only**:

- 🐛 **Bugs & Logic Errors** - Race conditions, null pointers, off-by-one errors
- 🔒 **Security Vulnerabilities** - Injection attacks, auth issues, data exposure  
- ⚡ **Performance Problems** - N+1 queries, memory leaks, inefficient algorithms

It **ignores** minor style issues and pedantic best-practice suggestions.

> **Note:** This is a best-effort AI agent. It may miss issues, produce false positives, or require multiple runs to catch everything. Always use human judgment alongside its output — it's a helpful second pair of eyes, not a replacement for code review.

## Preference Memory

The agent learns your coding preferences from your replies to its review comments. When you disagree with a suggestion or express a preference, it will:

1. **Extract the preference** from your reply
2. **Save it** to a `__agent_pr__` branch in `preferences.txt`
3. **Notify you** with a comment confirming what was learned
4. **Apply it** in future reviews

**Example:** If the agent suggests using `.then()` and you reply "I prefer async/await", it will remember this and avoid similar suggestions in the future.

Preferences are stored per-repository and persist across PRs.

## Tools Available to the Agent

### Review Mode (`/review`)

| Tool | Description |
|------|-------------|
| `read_files` | Read one or more file contents in a single call |
| `list_directory` | List directory contents with file sizes and line counts |
| `grep` | Search codebase for patterns (supports regex) |
| `get_file_outline` | Structural outline of a file — functions, classes, methods, and line ranges (uses tree-sitter) |
| `view_code_item` | View a specific function, class, or method by name (uses tree-sitter) |
| `find_references` | Find all references to a symbol across the codebase (syntax-aware) |
| `get_commit_diff` | Fetch the diff for a specific commit by SHA |
| `leave_comment` | Leave inline review comment on specific lines |
| `submit_review` | Submit final review summary |
| `search_web` | Search the web for documentation (requires `GEMINI_API_KEY`) |
| MCP tools | Any tools from configured MCP servers |

### Comment Reply Mode (`/question`, `/pr`, `/reply`)

| Tool | Description |
|------|-------------|
| `reply_to_comment` | Reply to the current code review comment thread |
| `store_preference` | Store a coding preference extracted from the user's reply |
| `read_files` | Read one or more file contents in a single call |
| `list_directory` | List directory contents with file sizes and line counts |
| `grep` | Search codebase for patterns (supports regex) |
| `get_file_outline` | Structural outline of a file — functions, classes, methods, and line ranges |
| `view_code_item` | View a specific function, class, or method by name |
| `find_references` | Find all references to a symbol across the codebase |
| `get_commit_diff` | Fetch the diff for a specific commit by SHA |
| `search_web` | Search the web for documentation (requires `GEMINI_API_KEY`) |
| MCP tools | Any tools from configured MCP servers |

## Example Output

When triggered, the agent will:

1. Analyze the PR diff and project structure
2. Read additional files for context as needed
3. Leave inline comments on problematic code
4. Submit a summary review

```
============================================================
Starting PR Review Agent
============================================================
Model: anthropic/claude-opus-4.6
Tools available: read_files, list_directory, grep, get_file_outline, view_code_item, find_references, get_commit_diff, leave_comment, submit_review, deepwiki_read_wiki_structure, ...
============================================================

Step 1
──────────────────────────────────────────────────────────────
🔧 Tool Calls:
  → read_files
    Args: {"files": [{"path": "src/auth.ts", "startLine": 45, "endLine": 60}]}

Step 2
──────────────────────────────────────────────────────────────
🔧 Tool Calls:
  → leave_comment
    Args: {"path": "src/auth.ts", "line": 52, "body": "**Issue**: SQL injection..."}
```

## Requirements

- GitHub Actions runner with Node.js 24+
- OpenRouter API key
- Repository with pull requests enabled

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
