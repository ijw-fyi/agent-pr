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
import { truncateDiffPart } from "../../index.js";
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
 * Filter a diff string to only include the specified files.
 * Returns the filtered diff with per-file truncation applied.
 */
function filterDiffToFiles(diff: string, files: string[]): string {
    const fileSet = new Set(files);
    const parts = diff.split(/(?=^diff --git )/m);

    return parts.filter(part => {
        if (!part.trim()) return true;
        const match = part.split('\n')[0].match(/diff --git a\/(.*?) b\//);
        return match ? fileSet.has(match[1]) : false;
    }).map(truncateDiffPart).join('');
}

/**
 * Build the context message for a sub-agent.
 * Includes PR metadata, the filtered diff (only assigned files), context hints
 * from the orchestrator, and repository guidelines.
 */
export function buildSubAgentContext(
    context: PRContext,
    contextHints: string,
    files: string[],
): string {
    const filteredDiff = filterDiffToFiles(context.diff, files);

    let message = `# Sub-Agent Review Task

## PR Information
- **Title**: ${context.title}
- **Author**: ${context.author}
- **Branch**: ${context.headBranch} → ${context.baseBranch}

## PR Description
${context.description || "(No description provided)"}

## Orchestrator Context
${contextHints}

## Files to Review (${files.length} files)
${files.map((f, i) => `${i + 1}. ${f}`).join("\n")}

## Changed Files Diff
\`\`\`diff
${filteredDiff}
\`\`\`
`;

    if (context.claudeMd) {
        message += `
## Repository Guidelines (CLAUDE.md)
\`\`\`
${context.claudeMd}
\`\`\`
`;
    }

    return message;
}

/**
 * Run a sub-agent to completion and return its final text response.
 *
 * Creates a fresh model and ReAct agent, streams it with budget monitoring,
 * and extracts the last AI message content as the result.
 */
export async function runSubAgent(
    name: string,
    systemPrompt: string,
    context: PRContext,
    contextHints: string,
    files: string[],
    recursionLimit: number,
): Promise<string> {
    console.log(`\n::group::🔍 Sub-agent: ${name} (${files.length} files, recursion limit: ${recursionLimit})`);
    console.log(`Files: ${files.join(", ")}`);
    console.log(`Context: ${contextHints.substring(0, 200)}${contextHints.length > 200 ? "..." : ""}`);
    console.log("::endgroup::");

    const subAgentTools = getSubAgentTools();
    const contextMessage = buildSubAgentContext(context, contextHints, files);
    const allMessages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(contextMessage),
    ];

    let lastAIContent = "";

    const { stepCount } = await streamWithBudget({
        agentName: name,
        tools: subAgentTools,
        messages: allMessages,
        recursionLimit,
        wrapUpMessage: "IMPORTANT BUDGET NOTICE: You are past your budget limit. Finish your current investigation item, then immediately provide your summary. Do not start investigating new items.",
        onChunk: (chunk) => {
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
 */
export function createSubAgentTool(
    name: string,
    description: string,
    prompt: string,
    context: PRContext,
    recursionLimit: number,
): StructuredToolInterface {
    return tool(
        async ({ context: contextHints, files }) => {
            return runSubAgent(name, prompt, context, contextHints, files, recursionLimit);
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
