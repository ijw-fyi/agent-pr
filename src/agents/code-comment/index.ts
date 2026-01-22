import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { PREFERENCE_PROMPT } from "./prompt.js";
import { storePreferenceTool } from "../../tools/store-preference.js";
import { replyToCommentTool } from "../../tools/reply-to-comment.js";
import { tools as reviewTools } from "../../tools/index.js";
import { readPreferences } from "../../preferences/index.js";
import { addReactionToReviewComment } from "../../context/github.js";
import { createCachedChatOpenAI, resetRunningCost, isOverBudget, getRunningCost, getBudget } from "../../helpers/cached-model.js";
import { processChunk } from "../../helpers/stream-utils.js";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Context for the preference agent
 */
export interface PreferenceContext {
    owner: string;
    repo: string;
    // The file path where the original comment was left
    filePath: string;
    // The code snippet that was commented on
    codeSnippet: string;
    // The comment chain (original comment + replies)
    commentChain: Array<{
        author: string;
        body: string;
        isBot: boolean;
    }>;
}

/**
 * Get the tools available to the code comment agent
 * Uses the shared tools array (includes MCP tools) plus preference-specific tools
 */
function getCodeCommentTools(): StructuredToolInterface[] {
    return [
        storePreferenceTool,
        replyToCommentTool,
        ...reviewTools,  // Includes read_file, list_directory, grep, search_web, and MCP tools
    ];
}

/**
 * Run the preference extraction agent
 */
export async function runPreferenceAgent(
    context: PreferenceContext,
    recursionLimit: number = 100
): Promise<void> {
    // Reset cost tracking for this run
    resetRunningCost();
    const budget = getBudget();
    console.log(`💵 Budget: $${budget.toFixed(2)}`);

    // Create the model with OpenRouter backend and prompt caching
    const model = createCachedChatOpenAI();

    // Get tools for the agent
    const tools = getCodeCommentTools();

    // Create agent with all available tools
    const agent = createReactAgent({
        llm: model,
        tools,
    });

    // Load existing preferences
    const existingPreferences = await readPreferences(context.owner, context.repo);

    // Build the system prompt with current preferences
    const systemPrompt =
        PREFERENCE_PROMPT +
        (existingPreferences
            ? `\n\`\`\`\n${existingPreferences}\n\`\`\``
            : "(No preferences stored yet)");

    // Build the context message
    const contextMessage = buildContextMessage(context);

    console.log("=".repeat(60));
    console.log("Starting Code Comment Agent");
    console.log("=".repeat(60));
    console.log(`File: ${context.filePath}`);
    console.log(`Comments in chain: ${context.commentChain.length}`);
    console.log(`Tools available: ${tools.map(t => t.name).join(", ")}`);
    console.log("=".repeat(60));

    // Add eyes reaction to show we're processing
    const commentId = process.env.COMMENT_ID ? parseInt(process.env.COMMENT_ID, 10) : null;
    if (commentId) {
        try {
            await addReactionToReviewComment(context.owner, context.repo, commentId, "eyes");
            console.log("👀 Added eyes reaction to comment");
        } catch (error) {
            console.log("Could not add eyes reaction:", error);
        }
    }

    // Stream the agent execution
    let stepCount = 0;
    const allMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage(contextMessage),
    ];

    const stream = await agent.stream(
        { messages: allMessages },
        { recursionLimit }
    );

    let budgetExceeded = false;
    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, allMessages);

        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - requesting wrap up`);
            break;
        }
    }

    // If budget exceeded, continue with wrap-up message
    if (budgetExceeded) {
        console.log("\n📝 Adding wrap-up message and continuing...");
        allMessages.push(new HumanMessage("IMPORTANT BUDGET NOTICE: You are past your budget limit. Wrap up soon by submitting your review with your findings so far. Focus on the most important issues."));

        const wrapUpStream = await agent.stream(
            { messages: allMessages },
            { recursionLimit: 10 }
        );

        for await (const chunk of wrapUpStream) {
            stepCount++;
            processChunk(chunk, stepCount, allMessages, true);
        }
    }

    const finalCost = getRunningCost();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Code Comment Agent completed. Total steps: ${stepCount}`);
    console.log(`💰 Final cost: $${finalCost.toFixed(4)} / $${budget.toFixed(2)} budget`);
    console.log("=".repeat(60));
}

/**
 * Build the context message for the preference agent
 */
function buildContextMessage(context: PreferenceContext): string {
    const comments = context.commentChain
        .map((c) => `**${c.author}${c.isBot ? " (bot)" : ""}**: ${c.body}`)
        .join("\n\n");

    return `## Code Context
File: \`${context.filePath}\`

\`\`\`
${context.codeSnippet}
\`\`\`

## Comment Chain
${comments}

## Your Task
Analyze this conversation. You have full access to exploration tools if you need more context.

1. If the user's reply reveals a coding preference, use \`store_preference\` to save it
2. If you want to respond to the user (clarify, ask a question, or continue the discussion), use \`reply_to_comment\`
3. If the conversation is complete and no preference was found, simply respond that no action is needed

You can use both tools if appropriate (e.g., save a preference AND reply to acknowledge it).
`;
}
