/**
 * Orchestrated review mode.
 *
 * Runs four specialized sub-agents (bugs, security, performance, code quality),
 * then a lightweight synthesizer combines their findings and submits the review.
 *
 * Cache optimization: all sub-agents share an identical SystemMessage[0]
 * containing the diff. The bugs agent starts first to warm the Anthropic
 * prompt cache; the other three start once the first chunk arrives (cache hit).
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { submitReviewTool } from "../../../tools/submit-review.js";
import { resetRunningCost, getBudget, logRunStats } from "../../../helpers/cached-model.js";
import { streamWithBudget } from "../../../helpers/stream-utils.js";
import { getVersion } from "../../../helpers/version.js";
import { findReviewCommentBody, stripOverrideFlags } from "../../../helpers/overrides.js";
import { extractChangedFiles } from "../index.js";
import { SYNTHESIZER_PROMPT } from "./prompt.js";
import { BUGS_PROMPT } from "./subagents/bugs.js";
import { SECURITY_PROMPT } from "./subagents/security.js";
import { PERFORMANCE_PROMPT } from "./subagents/performance.js";
import { CODE_QUALITY_PROMPT } from "./subagents/code-quality.js";
import { buildSharedSystemContent, runSubAgent } from "./subagents/shared.js";
import type { PRContext } from "../../../context/types.js";

/**
 * Extract user instructions from the /review trigger comment, if any.
 * Strips the /review command prefix and any override flags.
 */
function extractUserInstructions(context: PRContext): string {
    const reviewBody = findReviewCommentBody(context.conversation);
    if (!reviewBody) return "";
    const withoutCommand = reviewBody.replace(/^\/review\s*/, "");
    return stripOverrideFlags(withoutCommand);
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

    // Ensure bot login and review start time are available to tools for dedup
    process.env.REVIEW_START_TIME = new Date().toISOString();
    if (context.botLogin) {
        process.env.PR_AGENT_BOT_LOGIN = context.botLogin;
    }

    // Build shared system content once — cached and reused across all sub-agents
    const sharedSystemContent = buildSharedSystemContent(context);

    // Extract changed files and user instructions
    const changedFiles = extractChangedFiles(context.diff);
    const userInstructions = extractUserInstructions(context);
    let contextHints = userInstructions
        ? `User instructions: ${userInstructions}`
        : "No specific instructions — do a thorough review of your domain.";

    if (context.incrementalDiff) {
        contextHints += `\n\nThis is an **incremental re-review**. The diff shows only changes since commit \`${context.lastReviewedCommitSha!.substring(0, 7)}\`. Prioritize the new changes, but if you spot bugs in surrounding code during investigation, flag them too — just don't proactively hunt through unchanged files. Use \`read_files\` and \`grep\` for targeted investigation; use \`get_file_diff\` only when you need the full scope of a file's changes.`;
    }

    console.log(`\n📋 Changed files (${changedFiles.length}): ${changedFiles.join(", ")}`);
    if (userInstructions) {
        console.log(`📝 User instructions: ${userInstructions}`);
    }

    // --- Run sub-agents with staggered start for cache optimization ---
    // Bugs agent starts first (highest priority) and warms the prompt cache.
    // Security, performance, and code quality start once the first chunk arrives (cache hit).

    let resolveCacheReady: () => void;
    const cacheReady = new Promise<void>(r => { resolveCacheReady = r; });

    const bugsPromise = runSubAgent(
        "bugs_review",
        BUGS_PROMPT,
        sharedSystemContent,
        contextHints,
        changedFiles,
        effectiveRecursionLimit,
        () => resolveCacheReady!(),
    ).catch(err => {
        resolveCacheReady!(); // unblock other agents even if bugs agent fails
        throw err;            // re-throw so Promise.all still rejects
    });

    // Wait for cache to be warm before starting the other agents
    await cacheReady;

    const [bugsSummary, securitySummary, perfSummary, cqSummary] = await Promise.all([
        bugsPromise,
        runSubAgent(
            "security_review",
            SECURITY_PROMPT,
            sharedSystemContent,
            contextHints,
            changedFiles,
            effectiveRecursionLimit,
        ),
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

    const reviewScope = context.incrementalDiff
        ? `This was an **incremental re-review** — the diff focused on changes since commit \`${context.lastReviewedCommitSha!.substring(0, 7)}\`, though reviewers may have inspected full file diffs for additional context.`
        : `This was a **full review** of all changes in the PR.`;

    const synthesizerMessage = `Here are the findings from the four specialist reviewers:

## 🐛 Bugs Review
${bugsSummary}

## 🔒 Security Review
${securitySummary}

## ⚡ Performance Review
${perfSummary}

## 🧹 Code Quality Review
${cqSummary}

${reviewScope}

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
