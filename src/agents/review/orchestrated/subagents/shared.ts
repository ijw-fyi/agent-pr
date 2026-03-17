/**
 * Shared utilities for orchestrated review sub-agents.
 *
 * Provides tool filtering, context building, and a common runner
 * that each sub-agent tool delegates to.
 */

import { tool } from "@langchain/core/tools";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { tools } from "../../../../tools/index.js";
import { getAgentCosts } from "../../../../helpers/cached-model.js";
import { streamWithBudget } from "../../../../helpers/stream-utils.js";
import { truncateDiff, buildActivityTimeline } from "../../index.js";
import type { PRContext } from "../../../../context/types.js";

// Sub-agents can leave inline comments but cannot submit the final review
const SUBAGENT_BLOCKED_TOOLS = new Set(["submit_review"]);

/**
 * Get the tools available to sub-agents.
 * Includes all investigation tools and leave_comment, but excludes submit_review.
 */
export function getSubAgentTools(): StructuredToolInterface[] {
    return tools.filter(t => !SUBAGENT_BLOCKED_TOOLS.has(t.name));
}

/**
 * Build the shared system content that is identical across all sub-agents.
 * This goes into SystemMessage[0] so Anthropic's prefix cache is shared —
 * agent 1 writes the cache, agents 2+3 get cache hits on the diff.
 */
export function buildSharedSystemContent(context: PRContext): string {
    const isIncremental = !!context.incrementalDiff;
    const displayDiff = isIncremental ? context.incrementalDiff! : context.diff;

    let content = `# Pull Request Under Review

## PR Information
- **Title**: ${context.title}
- **Author**: ${context.author}
- **Branch**: ${context.headBranch} → ${context.baseBranch}
- **Your Identity**: You are \`${context.botLogin}\`. Comments and reviews by this user in the timeline below are from your previous runs.

## PR Description
${context.description || "(No description provided)"}
`;

    if (isIncremental) {
        content += `
## Changed Files Diff (incremental — changes since last review at \`${context.lastReviewedCommitSha!.substring(0, 7)}\`)
> **Note**: This diff only shows changes since your last review. Use the \`get_file_diff\` tool to see the full PR diff for any file if you need more context.

\`\`\`diff
${truncateDiff(displayDiff)}
\`\`\`
`;
    } else {
        content += `
## Changed Files Diff
\`\`\`diff
${truncateDiff(context.diff)}
\`\`\`
`;
    }

    const timeline = buildActivityTimeline(context);
    if (timeline) {
        content += `
## PR Activity Timeline
${timeline}
`;
    }

    if (context.claudeMd) {
        content += `
## Repository Guidelines (CLAUDE.md)
Treat these as project conventions and respect them when reviewing.
\`\`\`
${context.claudeMd}
\`\`\`
`;
    }

    if (context.preferences) {
        content += `
## User Preferences
The following preferences have been learned from previous interactions. Please respect these when reviewing:
\`\`\`
${context.preferences}
\`\`\`
`;
    }

    content += `
---
END OF PR CONTEXT. Your review instructions follow in the next system message.
`;

    return content;
}

/**
 * Build the per-agent user message with context hints and file assignments.
 */
function buildSubAgentUserMessage(contextHints: string, files: string[]): string {
    return `## Review Task

### Context from Orchestrator
${contextHints}

### Files to Review (${files.length} files)
${files.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Begin your review. Follow the phases in your system prompt exactly.`;
}

/**
 * Run a sub-agent to completion and return its final text response.
 *
 * Creates a fresh model and ReAct agent, streams it with budget monitoring,
 * and extracts the last AI message content as the result.
 *
 * @param onFirstChunk — optional callback fired on the first streaming chunk,
 *   used to signal that the prompt cache is warm so other agents can start.
 */
export async function runSubAgent(
    name: string,
    systemPrompt: string,
    sharedSystemContent: string,
    contextHints: string,
    files: string[],
    recursionLimit: number,
    onFirstChunk?: () => void,
): Promise<string> {
    console.log(`\n::group::🔍 Sub-agent: ${name} (${files.length} files, recursion limit: ${recursionLimit})`);
    console.log(`Files: ${files.join(", ")}`);
    console.log(`Context: ${contextHints.substring(0, 200)}${contextHints.length > 200 ? "..." : ""}`);
    console.log("::endgroup::");

    const subAgentTools = getSubAgentTools();
    const allMessages = [
        new SystemMessage(sharedSystemContent),                          // index 0: shared, cached
        new SystemMessage(systemPrompt),                                 // index 1: domain-specific
        new HumanMessage(buildSubAgentUserMessage(contextHints, files)), // index 2: per-invocation
    ];

    let lastAIContent = "";
    let firstChunkFired = false;

    const { stepCount } = await streamWithBudget({
        agentName: name,
        tools: subAgentTools,
        messages: allMessages,
        recursionLimit,
        wrapUpMessage: "IMPORTANT BUDGET NOTICE: You are past your budget limit. Finish your current investigation item, then immediately provide your summary. Do not start investigating new items.",
        onChunk: (chunk) => {
            if (!firstChunkFired && onFirstChunk) {
                firstChunkFired = true;
                onFirstChunk();
            }
            if (chunk.agent?.messages) {
                for (const msg of chunk.agent.messages) {
                    if (msg instanceof AIMessage) {
                        const content = typeof msg.content === "string" ? msg.content.trim() : "";
                        if (content) lastAIContent = content;
                    }
                }
            }
        },
    });

    const costs = getAgentCosts().get(name);
    if (costs) {
        console.log(`\n✅ [${name}] Complete. Steps: ${stepCount}, Cost: $${costs.cost.toFixed(4)}, Tokens: ${costs.inputTokens.toLocaleString()} in / ${costs.outputTokens.toLocaleString()} out`);
    } else {
        console.log(`\n✅ [${name}] Complete. Steps: ${stepCount}`);
    }
    return lastAIContent || `No findings from ${name} sub-agent.`;
}

/**
 * Factory for creating sub-agent tools.
 * All sub-agent tools share the same schema and runSubAgent call pattern —
 * only name, description, and prompt differ.
 *
 * Retained for potential future use (e.g., a dynamic orchestrator that
 * selectively invokes agents). Currently not used by the parallel pipeline.
 */
export function createSubAgentTool(
    name: string,
    description: string,
    prompt: string,
    sharedSystemContent: string,
    recursionLimit: number,
): StructuredToolInterface {
    return tool(
        async ({ context: contextHints, files }) => {
            return runSubAgent(name, prompt, sharedSystemContent, contextHints, files, recursionLimit);
        },
        {
            name,
            description,
            schema: z.object({
                context: z.string().describe("Context hints for the sub-agent — background about the PR, areas of concern, relevant details. This is additive guidance, NOT a restrictive focus."),
                files: z.array(z.string()).describe("List of file paths to review."),
            }),
        },
    );
}
