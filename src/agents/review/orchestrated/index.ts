/**
 * Orchestrated review mode.
 *
 * A main orchestrator agent triages the PR and delegates to
 * specialized sub-agents (security, performance, code quality).
 * Sub-agents leave inline comments; the orchestrator synthesizes
 * their findings and submits the final review.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { submitReviewTool } from "../../../tools/submit-review.js";
import { resetRunningCost, getBudget, logRunStats } from "../../../helpers/cached-model.js";
import { streamWithBudget } from "../../../helpers/stream-utils.js";
import { getVersion } from "../../../helpers/version.js";
import { buildContextMessage } from "../index.js";
import { ORCHESTRATOR_PROMPT } from "./prompt.js";
import { createSecurityReviewTool } from "./subagents/security.js";
import { createPerformanceReviewTool } from "./subagents/performance.js";
import { createCodeQualityReviewTool } from "./subagents/code-quality.js";
import type { PRContext } from "../../../context/types.js";

/**
 * Build the tool set for the orchestrator agent.
 * The orchestrator is a lightweight coordinator — it triages from the diff
 * already in its context message and delegates to sub-agents.
 * No investigation tools (read_files, grep, etc.) — sub-agents handle that.
 */
function getOrchestratorTools(context: PRContext, recursionLimit: number) {
    return [
        createSecurityReviewTool(context, recursionLimit),
        createPerformanceReviewTool(context, recursionLimit),
        createCodeQualityReviewTool(context, recursionLimit),
        submitReviewTool,
    ];
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

    // Build orchestrator tools
    const orchestratorTools = getOrchestratorTools(context, effectiveRecursionLimit);
    console.log(`Orchestrator tools: ${orchestratorTools.map(t => t.name).join(", ")}`);

    // Build the context message (same as single agent)
    const contextMessage = buildContextMessage(context);

    console.log("\n📝 Orchestrator Context Message:");
    console.log("─".repeat(60));
    console.log(contextMessage.substring(0, 2000) + (contextMessage.length > 2000 ? "\n... (truncated for log)" : ""));
    console.log("─".repeat(60));

    // Stream the orchestrator agent with budget monitoring
    const allMessages = [
        new SystemMessage(ORCHESTRATOR_PROMPT),
        new HumanMessage(contextMessage),
    ];

    const { stepCount } = await streamWithBudget({
        agentName: "orchestrator",
        tools: orchestratorTools,
        messages: allMessages,
        recursionLimit: effectiveRecursionLimit,
        wrapUpMessage: "IMPORTANT BUDGET NOTICE: You are past your budget limit. Submit your review immediately with submit_review using whatever findings you have so far. Mention in your summary that the review was cut short due to budget constraints.",
        wrapUpTools: [submitReviewTool],
    });

    logRunStats("Orchestrated review", stepCount);
}
