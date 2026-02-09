import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { COMMENT_REPLY_PROMPT } from "./prompt.js";
import { storePreferenceTool } from "../../tools/store-preference.js";
import { replyToCommentTool } from "../../tools/reply-to-comment.js";
import { tools as reviewTools } from "../../tools/index.js";
import { readPreferences } from "../../preferences/index.js";
import { createCachedChatOpenAI, resetRunningCost, isOverBudget, getRunningCost, getBudget, getRunningInputTokens, getRunningOutputTokens } from "../../helpers/cached-model.js";
import { processChunk } from "../../helpers/stream-utils.js";
import { getVersion } from "../../helpers/version.js";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Context for the comment reply agent
 */
export interface CommentReplyContext {
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
 * Get the tools available to the comment reply agent
 * Uses the shared tools array (includes MCP tools) plus preference-specific tools
 */
function getCommentReplyTools(): StructuredToolInterface[] {
    return [
        storePreferenceTool,
        replyToCommentTool,
        ...reviewTools,  // Includes read_files, list_directory, grep, search_web, and MCP tools
    ];
}

/**
 * Run the comment reply agent
 */
export async function runCommentReplyAgent(
    context: CommentReplyContext,
    recursionLimit: number = 100
): Promise<void> {
    // Only respond to comments on the bot's own review comments, or /review commands
    const originalComment = context.commentChain[0];
    const latestComment = context.commentChain[context.commentChain.length - 1];
    const isReviewCommand = latestComment?.body.trimStart().startsWith("/review");
    if (!originalComment?.isBot && !isReviewCommand) {
        console.log("⏭️ Skipping: original comment was not made by the bot");
        return;
    }

    // Reset cost tracking for this run
    resetRunningCost();
    const budget = getBudget();
    console.log(`💵 Budget: $${budget.toFixed(2)}`);

    // Create the model with OpenRouter backend and prompt caching
    const model = createCachedChatOpenAI();

    // Get tools for the agent
    const tools = getCommentReplyTools();

    // Create agent with all available tools
    const agent = createReactAgent({
        llm: model,
        tools,
    });

    // Load existing preferences
    const existingPreferences = await readPreferences(context.owner, context.repo);

    // Build the system prompt with current preferences
    const systemPrompt =
        COMMENT_REPLY_PROMPT +
        (existingPreferences
            ? `\n\`\`\`\n${existingPreferences}\n\`\`\``
            : "(No preferences stored yet)");

    // Build the context message
    const contextMessage = buildContextMessage(context);

    console.log("::group::🚀 Comment Reply Agent Starting");
    console.log(`Version: ${getVersion()}`);
    console.log(`Model: ${process.env.MODEL}`);
    console.log(`Repo: ${context.owner}/${context.repo}`);
    console.log(`SHA: ${process.env.HEAD_SHA || 'unknown'}`);
    console.log(`File: ${context.filePath}`);
    console.log(`Comments in chain: ${context.commentChain.length}`);
    console.log(`Budget: $${budget.toFixed(2)}`);
    console.log(`Tools: ${tools.map(t => t.name).join(", ")}`);
    console.log("::endgroup::");

    // Stream the agent execution
    let stepCount = 0;
    const allMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage(contextMessage),
    ];

    // Use AbortController to allow proper cancellation of the stream
    const abortController = new AbortController();

    const stream = await agent.stream(
        { messages: allMessages },
        { recursionLimit, signal: abortController.signal }
    );

    let budgetExceeded = false;
    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, allMessages);

        // Check budget after each step (only flag once)
        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - will wrap up after current tool calls`);
        }

        // If budget exceeded and we just got tool results, inject wrap-up and break
        if (budgetExceeded && chunk.tools?.messages) {
            console.log("\n📝 Injecting wrap-up message after tool results...");
            allMessages.push(new HumanMessage("IMPORTANT BUDGET NOTICE: You are past your budget limit. STOP exploring the code immediately. Compile your findings and respond to the user or save any preferences you've identified."));
            // Abort the stream to stop background processing
            console.log("🛑 Aborting original stream...");
            abortController.abort();
            break;
        }
    }

    // If we broke out due to budget, create a fresh agent for wrap-up
    if (budgetExceeded) {
        console.log("\n📝 Creating fresh model and agent for wrap-up...");

        // Create a completely fresh model instance to avoid any state issues
        const wrapUpModel = createCachedChatOpenAI();

        // Create a new agent instance with the fresh model
        const wrapUpAgent = createReactAgent({
            llm: wrapUpModel,
            tools,
        });

        try {
            const wrapUpStream = await wrapUpAgent.stream(
                { messages: allMessages },
                { recursionLimit: 20 }
            );

            for await (const chunk of wrapUpStream) {
                stepCount++;
                processChunk(chunk, stepCount, allMessages);
            }
            console.log("📝 Wrap-up complete");
        } catch (error) {
            console.error("Wrap-up error:", error);
        }
    }

    const finalCost = getRunningCost();
    const inputTokens = getRunningInputTokens();
    const outputTokens = getRunningOutputTokens();
    const totalTokens = inputTokens + outputTokens;

    // Calculate tool usage
    const toolUsage: Record<string, number> = {};
    const failedToolUsage: Record<string, number> = {};
    let totalToolCalls = 0;
    let totalFailedCalls = 0;

    for (const msg of allMessages) {
        if (msg instanceof ToolMessage && msg.name) {
            toolUsage[msg.name] = (toolUsage[msg.name] || 0) + 1;
            totalToolCalls++;

            // Check for failures
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (content.startsWith('Error')) {
                failedToolUsage[msg.name] = (failedToolUsage[msg.name] || 0) + 1;
                totalFailedCalls++;
            }
        }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Comment Reply Agent completed. Total steps: ${stepCount}`);
    console.log(`💰 Final cost: $${finalCost.toFixed(4)} / $${budget.toFixed(2)} budget`);
    console.log(`📊 Tokens: ${inputTokens.toLocaleString()} input, ${outputTokens.toLocaleString()} output, ${totalTokens.toLocaleString()} total`);
    console.log(`🔧 Tool Usage: ${totalToolCalls} calls${totalFailedCalls > 0 ? ` (${totalFailedCalls} failed)` : ''}`);

    if (totalToolCalls > 0) {
        Object.entries(toolUsage)
            .sort(([, a], [, b]) => b - a)
            .forEach(([name, count]) => {
                const failed = failedToolUsage[name] || 0;
                const failedStr = failed > 0 ? ` (⚠️ ${failed} failed)` : '';
                console.log(`  - ${name}: ${count}${failedStr}`);
            });
    }

    if (totalFailedCalls > 0) {
        console.log(`\n❌ Failed Tools:`);
        Object.entries(failedToolUsage)
            .sort(([, a], [, b]) => b - a)
            .forEach(([name, count]) => {
                console.log(`  - ${name}: ${count} error(s)`);
            });
    }
    console.log("=".repeat(60));
}

/**
 * Build the context message for the comment reply agent
 */
function buildContextMessage(context: CommentReplyContext): string {
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
