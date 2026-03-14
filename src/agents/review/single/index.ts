/**
 * Single-agent review mode.
 *
 * A single ReAct agent handles the entire review: triage, investigation,
 * inline comments, and final submission. This is the default review mode.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { getSystemPrompt } from "./prompt.js";
import { tools } from "../../../tools/index.js";
import { isWebSearchAvailable } from "../../../tools/search-web.js";
import type { PRContext } from "../../../context/types.js";
import { createCachedChatOpenAI, resetRunningCost, isOverBudget, getRunningCost, getBudget, getRunningInputTokens, getRunningOutputTokens, getRunningCacheReadTokens, getRunningCacheWriteTokens, getToolUsageStats } from "../../../helpers/cached-model.js";
import { processChunk } from "../../../helpers/stream-utils.js";
import { getVersion } from "../../../helpers/version.js";
import { buildContextMessage } from "../index.js";

/**
 * Run the single-agent PR review.
 */
export async function runSingleReview(
    context: PRContext,
    recursionLimit?: number,
): Promise<void> {
    // Reset cost tracking for this run
    resetRunningCost();
    const budget = getBudget();
    console.log(`💵 Budget: $${budget.toFixed(2)}`);

    // Create the model with OpenRouter backend and prompt caching
    const model = createCachedChatOpenAI();

    // Create the React agent
    const agent = createReactAgent({
        llm: model,
        tools,
    });

    // Build the initial context message
    const contextMessage = buildContextMessage(context);

    console.log("::group::🚀 PR Review Agent Starting");
    console.log(`Version: ${getVersion()}`);
    console.log(`Mode: single`);
    console.log(`Model: ${process.env.MODEL}`);
    console.log(`PR: ${context.owner}/${context.repo}#${context.prNumber}`);
    console.log(`SHA: ${process.env.HEAD_SHA || 'unknown'}`);
    console.log(`Branch: ${context.headBranch} → ${context.baseBranch}`);
    console.log(`Budget: $${budget.toFixed(2)}`);
    console.log(`Recursion Limit: ${recursionLimit}`);
    console.log(`Tools: ${tools.map(t => t.name).join(", ")}`);
    console.log("::endgroup::");

    console.log("\n📝 User Context Message:");
    console.log("─".repeat(60));
    console.log(contextMessage);
    console.log("─".repeat(60));

    // Stream the agent execution
    let stepCount = 0;
    const allMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(getSystemPrompt(isWebSearchAvailable())),
        new HumanMessage(contextMessage),
    ];

    // Use AbortController to allow proper cancellation of the stream
    const abortController = new AbortController();

    const stream = await agent.stream(
        { messages: allMessages },
        { recursionLimit, signal: abortController.signal }
    );

    let budgetExceeded = false;
    let abortedForBudget = false;
    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, allMessages);

        // Check budget after each step (only flag once)
        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - will wrap up after current tool calls`);
        }

        // If budget exceeded and we just got tool results, inject wrap-up and break
        // This ensures the LLM sees the budget notice before making more tool calls
        if (budgetExceeded && chunk.tools?.messages) {
            console.log("\n📝 Injecting wrap-up message after tool results...");
            allMessages.push(new HumanMessage("IMPORTANT BUDGET NOTICE: You are past your budget limit. Finish investigating your current checklist item, then submit your review immediately with submit_review. Skip remaining checklist items. Mention in your summary that the review was cut short due to budget constraints."));
            // Abort the stream to stop background processing
            console.log("🛑 Aborting original stream...");
            abortedForBudget = true;
            abortController.abort();
            break;
        }
    }

    // If we aborted the stream for budget, create a fresh agent for wrap-up
    // (If the agent finished naturally after budget exceeded, no wrap-up needed)
    if (abortedForBudget) {
        console.log("\n📝 Creating fresh model and agent for wrap-up...");

        // Create a completely fresh model instance to avoid any state issues
        const wrapUpModel = createCachedChatOpenAI();

        // Create a new agent instance with the fresh model
        const wrapUpAgent = createReactAgent({
            llm: wrapUpModel,
            tools,
        });

        try {
            const wrapUpStream = await wrapUpAgent.stream(
                { messages: allMessages },
                { recursionLimit: 20 }
            );

            for await (const chunk of wrapUpStream) {
                stepCount++;
                processChunk(chunk, stepCount, allMessages);
            }
            console.log("📝 Wrap-up complete");
        } catch (error) {
            console.error("Wrap-up error:", error);
        }
    }

    const finalCost = getRunningCost();
    const inputTokens = getRunningInputTokens();
    const outputTokens = getRunningOutputTokens();
    const totalTokens = inputTokens + outputTokens;
    const cacheReadTokens = getRunningCacheReadTokens();
    const cacheWriteTokens = getRunningCacheWriteTokens();
    const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / inputTokens * 100) : 0;

    // Get tool usage from global tracking
    const { toolUsage, failedToolUsage, totalCalls: totalToolCalls, totalFailed: totalFailedCalls } = getToolUsageStats();

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Review completed. Total steps: ${stepCount}`);
    console.log(`💰 Final cost: $${finalCost.toFixed(4)} / $${budget.toFixed(2)} budget`);
    console.log(`📊 Tokens: ${inputTokens.toLocaleString()} input, ${outputTokens.toLocaleString()} output, ${totalTokens.toLocaleString()} total`);
    console.log(`💾 Cache: ${cacheHitRate.toFixed(1)}% hit rate (${cacheReadTokens.toLocaleString()} read, ${cacheWriteTokens.toLocaleString()} write)`);
    console.log(`🔧 Tool Usage: ${totalToolCalls} calls${totalFailedCalls > 0 ? ` (${totalFailedCalls} failed)` : ''}`);

    if (totalToolCalls > 0) {
        Object.entries(toolUsage)
            .sort(([, a], [, b]) => b - a)
            .forEach(([name, count]) => {
                const failed = failedToolUsage[name] || 0;
                const failedStr = failed > 0 ? ` (⚠️ ${failed} failed)` : '';
                console.log(`  - ${name}: ${count}${failedStr}`);
            });
    }

    if (totalFailedCalls > 0) {
        console.log(`\n❌ Failed Tools:`);
        Object.entries(failedToolUsage)
            .sort(([, a], [, b]) => b - a)
            .forEach(([name, count]) => {
                console.log(`  - ${name}: ${count} error(s)`);
            });
    }
    console.log("=".repeat(60));
}
