import * as core from "@actions/core";
import { initGitHub, gatherPRContext, getOctokit } from "./context/github.js";
import { runReview } from "./agent/agent.js";
import { runPreferenceAgent } from "./agent/preference-agent.js";
import type { PreferenceContext } from "./agent/preference-agent.js";
import { initMCPClients, getMCPTools, closeMCPClients } from "./mcp/client.js";
import { addMCPTools } from "./tools/index.js";

/**
 * Main entry point for the PR Review Agent
 * Dispatches to either review mode or preference learning mode based on ACTION_MODE
 */
async function main(): Promise<void> {
    try {
        // Get configuration from environment
        const githubToken = process.env.GITHUB_TOKEN;
        const openrouterKey = process.env.OPENROUTER_KEY;
        const model = process.env.MODEL;
        const owner = process.env.REPO_OWNER;
        const repo = process.env.REPO_NAME;
        const prNumberStr = process.env.PR_NUMBER;
        const actionMode = process.env.ACTION_MODE || "review";

        // Validate required environment variables
        if (!githubToken) {
            throw new Error("GITHUB_TOKEN is required");
        }
        if (!openrouterKey) {
            throw new Error("OPENROUTER_KEY is required");
        }
        if (!model) {
            throw new Error("MODEL is required");
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
        if (actionMode === "preference") {
            await runPreferenceMode(owner, repo, prNumber);
        } else {
            await runReviewMode(owner, repo, prNumber, model);
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
    model: string
): Promise<void> {
    console.log(`Starting PR review for ${owner}/${repo}#${prNumber}`);
    console.log(`Using model: ${model}`);

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

    // Run the review
    console.log("Starting agent review...");
    await runReview(context);

    console.log("Review completed successfully!");
}

/**
 * Run the preference extraction agent
 */
async function runPreferenceMode(
    owner: string,
    repo: string,
    prNumber: number
): Promise<void> {
    const commentIdStr = process.env.COMMENT_ID;
    if (!commentIdStr) {
        throw new Error("COMMENT_ID is required for preference mode");
    }

    const commentId = parseInt(commentIdStr, 10);
    if (isNaN(commentId)) {
        throw new Error(`Invalid COMMENT_ID: ${commentIdStr}`);
    }

    console.log(`Processing comment reply for ${owner}/${repo}#${prNumber}`);
    console.log(`Comment ID: ${commentId}`);

    // Gather context for the preference agent
    const context = await gatherPreferenceContext(owner, repo, prNumber, commentId);

    if (!context) {
        console.log("Could not gather context for preference extraction");
        return;
    }

    // Run the preference agent
    await runPreferenceAgent(context);

    console.log("Preference extraction completed!");
}

/**
 * Gather context for the preference agent from a comment reply
 */
async function gatherPreferenceContext(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number
): Promise<PreferenceContext | null> {
    const octokit = getOctokit();

    // Get the comment that was replied to
    const { data: comment } = await octokit.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: commentId,
    });

    if (!comment.in_reply_to_id && !comment.body) {
        console.log("Comment is not a reply or has no body");
        return null;
    }

    // Get all review comments on this PR
    const { data: allComments } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
    });

    // Build the comment chain
    // Find the root comment and all replies
    const rootCommentId = comment.in_reply_to_id || comment.id;
    const rootComment = allComments.find((c) => c.id === rootCommentId);

    if (!rootComment) {
        console.log("Could not find root comment");
        return null;
    }

    // Get all comments in this thread (root + replies)
    const threadComments = allComments
        .filter((c) => c.id === rootCommentId || c.in_reply_to_id === rootCommentId)
        .sort(
            (a, b) =>
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

    // Build comment chain
    const commentChain = threadComments.map((c) => ({
        author: c.user?.login || "unknown",
        body: c.body,
        isBot: c.user?.type === "Bot",
    }));

    // Get the code snippet around the commented line
    const codeSnippet = rootComment.diff_hunk || "(no diff available)";

    return {
        owner,
        repo,
        filePath: rootComment.path,
        codeSnippet,
        commentChain,
    };
}

// Run the main function
main();
