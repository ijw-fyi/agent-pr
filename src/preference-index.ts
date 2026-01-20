import * as core from "@actions/core";
import { initGitHub, getOctokit } from "./context/github.js";
import { runPreferenceAgent } from "./agent/preference-agent.js";
import type { PreferenceContext } from "./agent/preference-agent.js";

/**
 * Entry point for preference extraction from inline comment replies.
 * Triggered by pull_request_review_comment events.
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
        const commentIdStr = process.env.COMMENT_ID;

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
        if (!commentIdStr) {
            throw new Error("COMMENT_ID is required");
        }

        const prNumber = parseInt(prNumberStr, 10);
        const commentId = parseInt(commentIdStr, 10);

        console.log(`Processing comment reply for ${owner}/${repo}#${prNumber}`);
        console.log(`Comment ID: ${commentId}`);

        // Initialize GitHub client
        initGitHub(githubToken);

        // Gather context for the preference agent
        const context = await gatherPreferenceContext(
            owner,
            repo,
            prNumber,
            commentId
        );

        if (!context) {
            console.log("Could not gather context for preference extraction");
            return;
        }

        // Run the preference agent
        await runPreferenceAgent(context);

        console.log("Preference extraction completed!");
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Error:", message);
        core.setFailed(message);
    }
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
