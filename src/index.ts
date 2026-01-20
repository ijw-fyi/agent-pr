import * as core from "@actions/core";
import { initGitHub, gatherPRContext } from "./context/github.js";
import { runReview } from "./agents/review/index.js";
import { runPreferenceAgent } from "./agents/code-comment/index.js";
import type { PreferenceContext } from "./agents/code-comment/index.js";
import { gatherPreferenceContext } from "./helpers/preference.js";
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



// Run the main function
main();
