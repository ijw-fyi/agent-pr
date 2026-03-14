/**
 * Orchestrated review mode.
 *
 * A main orchestrator agent triages the PR and delegates to
 * specialized sub-agents (security, performance, code quality).
 * Sub-agents leave inline comments; the orchestrator synthesizes
 * their findings and submits the final review.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tools } from "../../../tools/index.js";
import { submitReviewTool } from "../../../tools/submit-review.js";
import { createCachedChatOpenAI, resetRunningCost, isOverBudget, getRunningCost, getBudget, logRunStats } from "../../../helpers/cached-model.js";
import { processChunk } from "../../../helpers/stream-utils.js";
import { getVersion } from "../../../helpers/version.js";
import { buildContextMessage } from "../index.js";
import { ORCHESTRATOR_PROMPT } from "./prompt.js";
import { createSecurityReviewTool } from "./subagents/security.js";
import { createPerformanceReviewTool } from "./subagents/performance.js";
import { createCodeQualityReviewTool } from "./subagents/code-quality.js";
import type { PRContext } from "../../../context/types.js";

// The orchestrator does NOT get leave_comment (sub-agents handle inline comments)
// and does NOT get the sub-agent tools from the general pool.
// It gets: investigation tools + sub-agent tools + submit_review.
const ORCHESTRATOR_BLOCKED_TOOLS = new Set(["leave_comment", "submit_review"]);

/**
 * Build the tool set for the orchestrator agent.
 * Includes: investigation tools (read_files, grep, etc.), sub-agent tools,
 * and submit_review. Excludes leave_comment.
 */
function getOrchestratorTools(context: PRContext, recursionLimit: number): StructuredToolInterface[] {
    // Investigation tools (everything except leave_comment and submit_review)
    const investigationTools = tools.filter(t => !ORCHESTRATOR_BLOCKED_TOOLS.has(t.name));

    // Sub-agent tools
    const subAgentTools = [
        createSecurityReviewTool(context, recursionLimit),
        createPerformanceReviewTool(context, recursionLimit),
        createCodeQualityReviewTool(context, recursionLimit),
    ];

    return [...investigationTools, ...subAgentTools, submitReviewTool];
}

/**
 * Run the orchestrated review with sub-agents.
 */
export async function runOrchestratedReview(
    context: PRContext,
    recursionLimit?: number,
): Promise<void> {
    // Reset cost tracking for this run
    resetRunningCost();
    const budget = getBudget();
    const effectiveRecursionLimit = recursionLimit ?? 100;

    console.log("::group::🚀 Orchestrated PR Review Starting");
    console.log(`Version: ${getVersion()}`);
    console.log(`Mode: orchestrated`);
    console.log(`Model: ${process.env.MODEL}`);
    console.log(`PR: ${context.owner}/${context.repo}#${context.prNumber}`);
    console.log(`SHA: ${process.env.HEAD_SHA || 'unknown'}`);
    console.log(`Branch: ${context.headBranch} → ${context.baseBranch}`);
    console.log(`Budget: $${budget.toFixed(2)}`);
    console.log(`Recursion Limit: ${effectiveRecursionLimit} (orchestrator and sub-agents)`);
    console.log("::endgroup::");

    // Create the model
    const model = createCachedChatOpenAI("orchestrator");

    // Build orchestrator tools
    const orchestratorTools = getOrchestratorTools(context, effectiveRecursionLimit);
    console.log(`Orchestrator tools: ${orchestratorTools.map(t => t.name).join(", ")}`);

    // Create the orchestrator agent
    const agent = createReactAgent({
        llm: model,
        tools: orchestratorTools,
    });

    // Build the context message (same as single agent)
    const contextMessage = buildContextMessage(context);

    console.log("\n📝 Orchestrator Context Message:");
    console.log("─".repeat(60));
    console.log(contextMessage.substring(0, 2000) + (contextMessage.length > 2000 ? "\n... (truncated for log)" : ""));
    console.log("─".repeat(60));

    // Stream the orchestrator agent
    let stepCount = 0;
    const allMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(ORCHESTRATOR_PROMPT),
        new HumanMessage(contextMessage),
    ];

    const abortController = new AbortController();
    const stream = await agent.stream(
        { messages: allMessages },
        { recursionLimit: effectiveRecursionLimit, signal: abortController.signal },
    );

    let budgetExceeded = false;
    let abortedForBudget = false;
    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, allMessages);

        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - will wrap up after current tool calls`);
        }

        if (budgetExceeded && chunk.tools?.messages) {
            console.log("\n📝 Injecting wrap-up message after tool results...");
            allMessages.push(new HumanMessage(
                "IMPORTANT BUDGET NOTICE: You are past your budget limit. Submit your review immediately with submit_review using whatever findings you have so far. Mention in your summary that the review was cut short due to budget constraints."
            ));
            abortedForBudget = true;
            abortController.abort();
            break;
        }
    }

    // If we aborted the stream for budget, create a fresh agent for wrap-up
    // (If the agent finished naturally after budget exceeded, no wrap-up needed)
    if (abortedForBudget) {
        console.log("\n📝 Creating fresh agent for wrap-up...");
        const wrapUpModel = createCachedChatOpenAI("orchestrator");
        const wrapUpAgent = createReactAgent({
            llm: wrapUpModel,
            tools: orchestratorTools,
        });

        try {
            const wrapUpStream = await wrapUpAgent.stream(
                { messages: allMessages },
                { recursionLimit: 20 },
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

    logRunStats("Orchestrated review", stepCount);
}
