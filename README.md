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

#### Using shared workflows (recommended)
```yaml
name: PR Review

on:
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created, edited]
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  call-review:
    uses: ijw-fyi/.github-workflows/.github/workflows/pr_review.yml@main
    secrets: inherit
```

#### Full control 

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
          MODEL: ${{ vars.PR_REVIEW_MODEL || 'anthropic/claude-4.5-sonnet' }}
          MCP_CONFIG: ${{ vars.MCP_CONFIG || '{"servers":[{"name":"deepwiki","transport":"http","url":"https://mcp.deepwiki.com/mcp"}]}' }}
          ACTION_MODE: review
          PR_NUMBER: ${{ github.event.issue.number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
          BASE_SHA: ${{ steps.pr.outputs.base_sha }}
          TRIGGER_COMMENT_ID: ${{ github.event.comment.id }}

  pr_code_message:
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
      
      - name: Run Preference Agent
        uses: ijw-fyi/agent-pr@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_KEY: ${{ secrets.OPENROUTER_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          MODEL: ${{ vars.PR_REVIEW_MODEL || 'anthropic/claude-4.5-sonnet' }}
          MCP_CONFIG: ${{ vars.MCP_CONFIG || '{"servers":[{"name":"deepwiki","transport":"http","url":"https://mcp.deepwiki.com/mcp"}]}' }}
          ACTION_MODE: preference
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          COMMENT_ID: ${{ github.event.comment.id }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
```

### 2. Add secrets to your repository (Handled at ORG level, SKIP)

Go to **Settings → Secrets and variables → Actions**:

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENROUTER_KEY` | ✅ Yes | Your [OpenRouter](https://openrouter.ai/) API key |
| `GEMINI_API_KEY` | ❌ No | Enables web search tool (Google AI) |

### 3. Trigger a review

Comment `/review` on any pull request!

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `anthropic/claude-4.5-sonnet` | OpenRouter model identifier |
| `MCP_CONFIG` | DeepWiki enabled | JSON config for MCP servers |
| `GEMINI_API_KEY` | - | Enables web search with Gemini |

### Model Selection

Any model available on [OpenRouter](https://openrouter.ai/models) works. Examples:

```yaml
MODEL: 'anthropic/claude-4.5-sonnet'  # Default, great for code
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

## What the Agent Reviews

The agent focuses on **significant issues only**:

- 🐛 **Bugs & Logic Errors** - Race conditions, null pointers, off-by-one errors
- 🔒 **Security Vulnerabilities** - Injection attacks, auth issues, data exposure  
- ⚡ **Performance Problems** - N+1 queries, memory leaks, inefficient algorithms

It **ignores** minor style issues and pedantic best-practice suggestions.

## Preference Memory

The agent learns your coding preferences from your replies to its review comments. When you disagree with a suggestion or express a preference, it will:

1. **Extract the preference** from your reply
2. **Save it** to a `__agent_pr__` branch in `preferences.txt`
3. **Notify you** with a comment confirming what was learned
4. **Apply it** in future reviews

**Example:** If the agent suggests using `.then()` and you reply "I prefer async/await", it will remember this and avoid similar suggestions in the future.

Preferences are stored per-repository and persist across PRs.

## Tools Available to the Agent

| Tool | Description |
|------|-------------|
| `read_files` | Read one or more file contents in a single call |
| `grep` | Search codebase for patterns (supports regex) |
| `leave_comment` | Leave inline review comment on PR |
| `submit_review` | Submit final review summary |
| `search_web` | Search web for docs (requires `GEMINI_API_KEY`) |
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
Model: anthropic/claude-4.5-sonnet
Tools available: read_files, leave_comment, submit_review, deepwiki_ask
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
