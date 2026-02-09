import * as core from "@actions/core";
import { initGitHub, gatherPRContext, addReactionToComment, addReactionToReviewComment } from "./context/github.js";
import { runReview } from "./agents/review/index.js";
import { runCommentReplyAgent } from "./agents/comment-reply/index.js";
import type { CommentReplyContext } from "./agents/comment-reply/index.js";
import { gatherCommentReplyContext } from "./helpers/preference.js";
import { initMCPClients, getMCPTools, closeMCPClients } from "./mcp/client.js";
import { addMCPTools } from "./tools/index.js";
import { findReviewCommentBody, processReviewOverrides, stripOverrideFlags } from "./helpers/overrides.js";

/**
 * Main entry point for the PR Review Agent
 * Dispatches to either review mode or comment reply mode based on ACTION_MODE
 */
async function main(): Promise<void> {
    try {
        // Validate env vars required to fetch context (before overrides)
        const githubToken = process.env.GITHUB_TOKEN;
        const openrouterKey = process.env.OPENROUTER_KEY;
        const owner = process.env.REPO_OWNER;
        const repo = process.env.REPO_NAME;
        const prNumberStr = process.env.PR_NUMBER;
        const actionMode = process.env.ACTION_MODE || "review";

        if (!githubToken) {
            throw new Error("GITHUB_TOKEN is required");
        }
        if (!openrouterKey) {
            throw new Error("OPENROUTER_KEY is required");
        }
        if (!owner || !repo || !prNumberStr) {
            throw new Error("REPO_OWNER, REPO_NAME, and PR_NUMBER are required");
        }

        const prNumber = parseInt(prNumberStr, 10);
        if (isNaN(prNumber)) {
            throw new Error(`Invalid PR_NUMBER: ${prNumberStr}`);
        }

        // Initialize GitHub client
        initGitHub(githubToken);

        // Dispatch based on action mode
        // MODEL and RECURSION_LIMIT are validated after overrides are applied
        if (actionMode === "comment-reply") {
            await runCommentReplyMode(owner, repo, prNumber);
        } else {
            await runReviewMode(owner, repo, prNumber);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Error:", message);
        core.setFailed(message);
    } finally {
        // Cleanup MCP connections (only used in review mode, but safe to call)
        await closeMCPClients();
    }
}

/**
 * Run the review agent
 */
async function runReviewMode(
    owner: string,
    repo: string,
    prNumber: number,
): Promise<void> {
    console.log(`Starting PR review for ${owner}/${repo}#${prNumber}`);

    // Add eyes reaction to the triggering comment to show we've started
    const triggerCommentId = process.env.TRIGGER_COMMENT_ID;
    if (triggerCommentId) {
        try {
            await addReactionToComment(owner, repo, parseInt(triggerCommentId, 10), "eyes");
            console.log("Added 👀 reaction to trigger comment");
        } catch (error) {
            console.warn("Could not add reaction to comment:", error);
        }
    }

    // Initialize MCP clients and add their tools
    await initMCPClients();
    const mcpTools = await getMCPTools();
    if (mcpTools.length > 0) {
        addMCPTools(mcpTools);
        console.log(`Added ${mcpTools.length} MCP tool(s)`);
    }

    // Gather PR context
    console.log("Gathering PR context...");
    const context = await gatherPRContext(owner, repo, prNumber);
    console.log(`PR: "${context.title}" by ${context.author}`);
    console.log(`Changes: ${context.headBranch} → ${context.baseBranch}`);
    console.log(`HEAD SHA: ${context.headSha}`);

    // Parse overrides from the /review trigger comment
    // This must happen before reading MODEL/RECURSION_LIMIT so --model/--recursion-limit work
    const reviewBody = findReviewCommentBody(context.conversation);
    if (reviewBody) {
        processReviewOverrides(reviewBody);
    }

    // Strip override flags from all comments
    for (const comment of context.conversation) {
        comment.body = stripOverrideFlags(comment.body);
    }

    // Validate overridable env vars after overrides are applied
    const model = process.env.MODEL;
    if (!model) {
        throw new Error("MODEL is required (set via env var or --model flag)");
    }
    console.log(`Using model: ${model}`);

    const recursionLimit = getRecursionLimit();

    // Set HEAD_SHA for tools that need it
    process.env.HEAD_SHA = context.headSha;

    // Run the review
    console.log("Starting agent review...");
    await runReview(context, recursionLimit);

    console.log("Review completed successfully!");
}

function getRecursionLimit(): number {
    const str = process.env.RECURSION_LIMIT || "100";
    const parsed = parseInt(str, 10);
    if (isNaN(parsed)) {
        console.warn(`Invalid RECURSION_LIMIT: ${str}, using default 100`);
        return 100;
    }
    return parsed;
}

async function runCommentReplyMode(
    owner: string,
    repo: string,
    prNumber: number,
): Promise<void> {
    const commentIdStr = process.env.COMMENT_ID;
    if (!commentIdStr) {
        throw new Error("COMMENT_ID is required for comment-reply mode");
    }

    const commentId = parseInt(commentIdStr, 10);
    if (isNaN(commentId)) {
        throw new Error(`Invalid COMMENT_ID: ${commentIdStr}`);
    }

    console.log(`Processing comment reply for ${owner}/${repo}#${prNumber}`);
    console.log(`Comment ID: ${commentId}`);

    // Add eyes reaction immediately to show we're processing
    try {
        await addReactionToReviewComment(owner, repo, commentId, "eyes");
        console.log("Added 👀 reaction to comment");
    } catch (error) {
        console.warn("Could not add eyes reaction:", error);
    }

    // Initialize MCP clients and add their tools
    await initMCPClients();
    const mcpTools = await getMCPTools();
    if (mcpTools.length > 0) {
        addMCPTools(mcpTools);
        console.log(`Added ${mcpTools.length} MCP tool(s)`);
    }

    // Gather context for the comment reply agent
    const context = await gatherCommentReplyContext(owner, repo, prNumber, commentId);

    if (!context) {
        console.log("Could not gather context for comment reply");
        return;
    }

    // Check for slash commands (/question, /pr, /reply) before stripping them.
    // latestComment is always the triggering comment (the one that fired the workflow),
    // since COMMENT_ID comes from github.event.comment.id and the thread is sorted by created_at.
    const latestComment = context.commentChain[context.commentChain.length - 1];
    const isSlashCommand = /^\s*\/(question|pr|reply)/i.test(latestComment?.body ?? "");
    const originalComment = context.commentChain[0];

    // Two cases where we respond:
    // 1. The root comment in the thread was left by the bot (user is replying to our review)
    // 2. The triggering comment is a slash command (user is asking a question on any code)
    // All other review comments are ignored to avoid noise.
    if (!originalComment?.isBot && !isSlashCommand) {
        console.log("⏭️ Skipping: original comment was not made by the bot and no slash command found");
        return;
    }

    // Parse overrides (--model, --budget, etc.) from the slash command comment.
    // We intentionally parse from latestComment (the triggering comment) rather than
    // searching the whole thread, since overrides only make sense on the command that
    // initiated this run.
    if (isSlashCommand) {
        processReviewOverrides(latestComment.body);
    }

    // Strip override flags and slash commands from all comments so the AI sees
    // clean conversation text without command syntax or flag noise.
    for (const comment of context.commentChain) {
        comment.body = stripOverrideFlags(comment.body);
        comment.body = comment.body.replace(/^\s*\/(question|pr|reply)\s*/i, '').trim();
    }

    // Run the comment reply agent
    await runCommentReplyAgent(context, getRecursionLimit());

    console.log("Comment reply agent completed!");
}



// Run the main function
main();
