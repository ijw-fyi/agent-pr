import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { submitPRReview, setReviewLabel } from "../context/github.js";
import { getRunningCost, getBudget, getRunningInputTokens, getRunningOutputTokens, getRunningCacheReadTokens, getRunningCacheWriteTokens, getToolUsageStats } from "../helpers/cached-model.js";

/**
 * Tool to submit the final review with a summary
 */
export const submitReviewTool = tool(
    async ({ summary, verdict }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);

        try {
            // Build the review summary comment
            const verdictEmoji = {
                approve: "✅",
                request_changes: "⚠️",
                comment: "💬",
            }[verdict];

            const verdictText = {
                approve: "Looks good!",
                request_changes: "Changes requested",
                comment: "Review complete",
            }[verdict];

            // Map verdict to GitHub review event type
            const reviewEvent = {
                approve: "APPROVE",
                request_changes: "REQUEST_CHANGES",
                comment: "COMMENT",
            }[verdict] as "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

            // Build stats
            const cost = getRunningCost();
            const budget = getBudget();
            const inputTokens = getRunningInputTokens();
            const outputTokens = getRunningOutputTokens();
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = getRunningCacheReadTokens();
            const cacheWriteTokens = getRunningCacheWriteTokens();
            const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / inputTokens * 100) : 0;
            const { toolUsage, failedToolUsage, totalCalls, totalFailed } = getToolUsageStats();

            const toolsTable = Object.entries(toolUsage)
                .sort(([, a], [, b]) => b - a)
                .map(([name, count]) => {
                    const failed = failedToolUsage[name] || 0;
                    const status = failed > 0 ? `${count} (⚠️ ${failed} failed)` : `${count}`;
                    return `| ${name} | ${status} |`;
                })
                .join('\n');

            const body = `## ${verdictEmoji} ${verdictText}

${summary}

---
<details>
<summary>📊 Review Stats</summary>

| Metric | Value |
|--------|-------|
| 🤖 Model | ${process.env.MODEL || 'unknown'} |
| 💰 Cost | $${cost.toFixed(4)} / $${budget.toFixed(2)} budget |
| 📝 Tokens | ${totalTokens.toLocaleString()} (${inputTokens.toLocaleString()} in, ${outputTokens.toLocaleString()} out) |
| 💾 Cache Hit Rate | ${cacheHitRate.toFixed(1)}% (${cacheReadTokens.toLocaleString()} read, ${cacheWriteTokens.toLocaleString()} write) |

**🔧 Tool Usage** (${totalCalls} calls${totalFailed > 0 ? `, ${totalFailed} failed` : ''})

| Tool | Calls |
|------|-------|
${toolsTable || '| (none) | - |'}

</details>`;

            // Submit an actual GitHub PR review (approve/request changes/comment)
            const commitId = process.env.HEAD_SHA;
            await submitPRReview(owner, repo, prNumber, body, reviewEvent, commitId);

            // Add verdict label to the PR
            await setReviewLabel(owner, repo, prNumber, verdict);

            return `Review submitted successfully with verdict: ${verdict}`;
        } catch (error) {
            console.error(`❌ Error in submit_review:`, error);
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error submitting review: ${message}`;
        }
    },
    {
        name: "submit_review",
        description:
            "Submit the final review with a summary comment. Call this after leaving all inline comments to provide an overall assessment of the PR.",
        schema: z.object({
            summary: z
                .string()
                .describe(
                    "A summary of your review findings. Include key issues found, positive aspects, and overall recommendations."
                ),
            verdict: z
                .enum(["approve", "request_changes", "comment"])
                .describe(
                    "Your overall verdict: 'approve' if the code is good, 'request_changes' if there are issues that must be fixed, 'comment' for feedback without blocking."
                ),
        }),
    }
);
