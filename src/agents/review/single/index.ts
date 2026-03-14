/**
 * Single-agent review mode.
 *
 * A single ReAct agent handles the entire review: triage, investigation,
 * inline comments, and final submission. This is the default review mode.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getSystemPrompt } from "./prompt.js";
import { tools } from "../../../tools/index.js";
import { isWebSearchAvailable } from "../../../tools/search-web.js";
import type { PRContext } from "../../../context/types.js";
import { resetRunningCost, getBudget, logRunStats } from "../../../helpers/cached-model.js";
import { streamWithBudget } from "../../../helpers/stream-utils.js";
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

    // Stream the agent execution with budget monitoring
    const allMessages = [
        new SystemMessage(getSystemPrompt(isWebSearchAvailable())),
        new HumanMessage(contextMessage),
    ];

    const { stepCount } = await streamWithBudget({
        agentName: "single_review",
        tools,
        messages: allMessages,
        recursionLimit: recursionLimit ?? 100,
        wrapUpMessage: "IMPORTANT BUDGET NOTICE: You are past your budget limit. Finish investigating your current checklist item, then submit your review immediately with submit_review. Skip remaining checklist items. Mention in your summary that the review was cut short due to budget constraints.",
    });

    logRunStats("Review", stepCount);
}
