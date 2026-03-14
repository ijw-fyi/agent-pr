/**
 * Shared utilities for orchestrated review sub-agents.
 *
 * Provides tool filtering, context building, and a common runner
 * that each sub-agent tool delegates to.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tools } from "../../../../tools/index.js";
import { createCachedChatOpenAI, isOverBudget, getRunningCost, getBudget, getAgentCosts } from "../../../../helpers/cached-model.js";
import { processChunk } from "../../../../helpers/stream-utils.js";
import { truncateDiff } from "../../index.js";
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

    const filtered = parts.filter(part => {
        if (!part.trim()) return true;
        const headerLine = part.split('\n')[0];
        const match = headerLine.match(/diff --git a\/(.*?) b\//);
        if (match) {
            return fileSet.has(match[1]);
        }
        return false;
    }).join('');

    return truncateDiff(filtered);
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

    const model = createCachedChatOpenAI(name);
    const subAgentTools = getSubAgentTools();
    const agent = createReactAgent({ llm: model, tools: subAgentTools });

    const contextMessage = buildSubAgentContext(context, contextHints, files);
    const allMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage(contextMessage),
    ];

    const abortController = new AbortController();
    const stream = await agent.stream(
        { messages: allMessages },
        { recursionLimit, signal: abortController.signal },
    );

    let stepCount = 0;
    let lastAIContent = "";
    let budgetExceeded = false;
    let abortedForBudget = false;
    const budget = getBudget();

    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, allMessages);

        // Capture the latest AI message text
        if (chunk.agent?.messages) {
            for (const msg of chunk.agent.messages) {
                if (msg instanceof AIMessage) {
                    const content = typeof msg.content === "string" ? msg.content.trim() : "";
                    if (content) lastAIContent = content;
                }
            }
        }

        // Budget check
        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ [${name}] Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - wrapping up`);
        }

        if (budgetExceeded && chunk.tools?.messages) {
            console.log(`\n📝 [${name}] Injecting wrap-up message after tool results...`);
            allMessages.push(new HumanMessage(
                "IMPORTANT BUDGET NOTICE: You are past your budget limit. Finish your current investigation item, then immediately provide your summary. Do not start investigating new items."
            ));
            abortedForBudget = true;
            abortController.abort();
            break;
        }
    }

    // If we aborted the stream for budget, run a wrap-up pass
    // (If the agent finished naturally after budget exceeded, no wrap-up needed)
    if (abortedForBudget) {
        console.log(`\n📝 [${name}] Running wrap-up pass...`);
        const wrapUpModel = createCachedChatOpenAI(name);
        const wrapUpAgent = createReactAgent({ llm: wrapUpModel, tools: subAgentTools });

        try {
            const wrapUpStream = await wrapUpAgent.stream(
                { messages: allMessages },
                { recursionLimit: 20 },
            );

            for await (const chunk of wrapUpStream) {
                stepCount++;
                processChunk(chunk, stepCount, allMessages);
                if (chunk.agent?.messages) {
                    for (const msg of chunk.agent.messages) {
                        if (msg instanceof AIMessage) {
                            const content = typeof msg.content === "string" ? msg.content.trim() : "";
                            if (content) lastAIContent = content;
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`[${name}] Wrap-up error:`, error);
        }
    }

    const costs = getAgentCosts().get(name);
    if (costs) {
        console.log(`\n✅ [${name}] Complete. Steps: ${stepCount}, Cost: $${costs.cost.toFixed(4)}, Tokens: ${costs.inputTokens.toLocaleString()} in / ${costs.outputTokens.toLocaleString()} out`);
    } else {
        console.log(`\n✅ [${name}] Complete. Steps: ${stepCount}`);
    }
    return lastAIContent || `No findings from ${name} sub-agent.`;
}
