/**
 * Orchestrated review mode.
 *
 * Runs three specialized sub-agents in parallel (security, performance,
 * code quality), then a lightweight synthesizer combines their findings
 * and submits the final review.
 *
 * Cache optimization: all sub-agents share an identical SystemMessage[0]
 * containing the diff. Agent 1 starts first to warm the Anthropic prompt
 * cache; agents 2+3 start once the first chunk arrives (cache hit).
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { submitReviewTool } from "../../../tools/submit-review.js";
import { resetRunningCost, getBudget, logRunStats } from "../../../helpers/cached-model.js";
import { streamWithBudget } from "../../../helpers/stream-utils.js";
import { getVersion } from "../../../helpers/version.js";
import { extractChangedFiles } from "../index.js";
import { SYNTHESIZER_PROMPT } from "./prompt.js";
import { SECURITY_PROMPT } from "./subagents/security.js";
import { PERFORMANCE_PROMPT } from "./subagents/performance.js";
import { CODE_QUALITY_PROMPT } from "./subagents/code-quality.js";
import { buildSharedSystemContent, runSubAgent } from "./subagents/shared.js";
import type { PRContext } from "../../../context/types.js";

/**
 * Extract user instructions from the /review trigger comment, if any.
 * Strips the /review command prefix and any flags.
 */
function extractUserInstructions(context: PRContext): string {
    // Look for the trigger comment in conversation
    const triggerCommentId = process.env.TRIGGER_COMMENT_ID;
    let reviewBody: string | null = null;

    if (triggerCommentId) {
        const id = parseInt(triggerCommentId, 10);
        const match = context.conversation.find(c => c.id === id);
        if (match) reviewBody = match.body;
    }

    if (!reviewBody) {
        // Fall back to last /review comment
        for (let i = context.conversation.length - 1; i >= 0; i--) {
            if (context.conversation[i].body.trimStart().startsWith('/review')) {
                reviewBody = context.conversation[i].body;
                break;
            }
        }
    }

    if (!reviewBody) return "";

    // Strip the /review command and any --flags
    const withoutCommand = reviewBody.replace(/^\/review\s*/, "");
    const withoutFlags = withoutCommand.replace(/--\w+(?:\s+\S+)?/g, "").trim();
    return withoutFlags;
}

/**
 * Run the orchestrated review with parallel sub-agents + synthesizer.
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
    console.log(`Mode: orchestrated (parallel)`);
    console.log(`Model: ${process.env.MODEL}`);
    console.log(`PR: ${context.owner}/${context.repo}#${context.prNumber}`);
    console.log(`SHA: ${process.env.HEAD_SHA || 'unknown'}`);
    console.log(`Branch: ${context.headBranch} → ${context.baseBranch}`);
    console.log(`Budget: $${budget.toFixed(2)}`);
    console.log(`Recursion Limit: ${effectiveRecursionLimit} (per sub-agent)`);
    console.log("::endgroup::");

    // Build shared system content once — cached and reused across all sub-agents
    const sharedSystemContent = buildSharedSystemContent(context);

    // Extract changed files and user instructions
    const changedFiles = extractChangedFiles(context.diff);
    const userInstructions = extractUserInstructions(context);
    const contextHints = userInstructions
        ? `User instructions: ${userInstructions}`
        : "No specific instructions — do a thorough review of your domain.";

    console.log(`\n📋 Changed files (${changedFiles.length}): ${changedFiles.join(", ")}`);
    if (userInstructions) {
        console.log(`📝 User instructions: ${userInstructions}`);
    }

    // --- Run sub-agents with staggered start for cache optimization ---
    // Agent 1 starts immediately and warms the prompt cache.
    // Agents 2+3 start once agent 1's first chunk arrives (cache hit).

    let resolveCacheReady: () => void;
    const cacheReady = new Promise<void>(r => { resolveCacheReady = r; });

    const securityPromise = runSubAgent(
        "security_review",
        SECURITY_PROMPT,
        sharedSystemContent,
        contextHints,
        changedFiles,
        effectiveRecursionLimit,
        () => resolveCacheReady!(),
    );

    // Wait for cache to be warm before starting agents 2+3
    await cacheReady;

    const [securitySummary, perfSummary, cqSummary] = await Promise.all([
        securityPromise,
        runSubAgent(
            "performance_review",
            PERFORMANCE_PROMPT,
            sharedSystemContent,
            contextHints,
            changedFiles,
            effectiveRecursionLimit,
        ),
        runSubAgent(
            "code_quality_review",
            CODE_QUALITY_PROMPT,
            sharedSystemContent,
            contextHints,
            changedFiles,
            effectiveRecursionLimit,
        ),
    ]);

    // --- Synthesizer: combine findings and submit review ---
    console.log("\n::group::📝 Synthesizer: combining findings");
    console.log("::endgroup::");

    const synthesizerMessage = `Here are the findings from the three specialist reviewers:

## 🔒 Security Review
${securitySummary}

## ⚡ Performance Review
${perfSummary}

## 🧹 Code Quality Review
${cqSummary}

Combine these into a unified review summary and submit it using submit_review.`;

    const { stepCount: synthSteps } = await streamWithBudget({
        agentName: "synthesizer",
        tools: [submitReviewTool],
        messages: [
            new SystemMessage(SYNTHESIZER_PROMPT),
            new HumanMessage(synthesizerMessage),
        ],
        recursionLimit: 10,
        wrapUpMessage: "IMPORTANT: Submit the review immediately with submit_review using whatever findings you have.",
    });

    logRunStats("Orchestrated review", synthSteps);
}
