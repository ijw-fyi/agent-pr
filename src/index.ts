import * as core from "@actions/core";
import { initGitHub, gatherPRContext } from "./context/github.js";
import { runReview } from "./agent/agent.js";
import { initMCPClients, getMCPTools, closeMCPClients } from "./mcp/client.js";
import { addMCPTools } from "./tools/index.js";

/**
 * Main entry point for the PR Review Agent
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

        console.log(`Starting PR review for ${owner}/${repo}#${prNumber}`);
        console.log(`Using model: ${model}`);

        // Initialize GitHub client
        initGitHub(githubToken);

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
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Error:", message);
        core.setFailed(message);
    } finally {
        // Cleanup MCP connections
        await closeMCPClients();
    }
}

// Run the main function
main();
