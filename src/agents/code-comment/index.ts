import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { PREFERENCE_PROMPT } from "./prompt.js";
import { storePreferenceTool } from "../../tools/store-preference.js";
import { replyToCommentTool } from "../../tools/reply-to-comment.js";
import { readFileTool } from "../../tools/read-file.js";
import { listDirectoryTool } from "../../tools/list-directory.js";
import { grepTool } from "../../tools/grep.js";
import { searchWebTool, isWebSearchAvailable } from "../../tools/search-web.js";
import { readPreferences } from "../../preferences/index.js";
import { addReactionToReviewComment } from "../../context/github.js";
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
 */
function getCodeCommentTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
        storePreferenceTool,
        replyToCommentTool,
        readFileTool,
        listDirectoryTool,
        grepTool,
    ];

    // Only include web search tool if GEMINI_API_KEY is available
    if (isWebSearchAvailable()) {
        tools.push(searchWebTool);
    }

    return tools;
}

/**
 * Run the preference extraction agent
 */
export async function runPreferenceAgent(
    context: PreferenceContext,
    recursionLimit: number = 100
): Promise<void> {
    // Create the model with OpenRouter backend
    const model = new ChatOpenAI({
        modelName: process.env.MODEL!,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        apiKey: process.env.OPENROUTER_KEY!,
    });

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

    // Stream the agent execution to log each step
    let stepCount = 0;
    const stream = await agent.stream(
        {
            messages: [
                new SystemMessage(systemPrompt),
                new HumanMessage(contextMessage),
            ],
        },
        {
            recursionLimit,
        }
    );

    for await (const chunk of stream) {
        stepCount++;
        console.log(`\n${"─".repeat(60)}`);
        console.log(`Step ${stepCount}`);
        console.log("─".repeat(60));

        // Log agent messages (LLM responses)
        if (chunk.agent?.messages) {
            for (const msg of chunk.agent.messages) {
                if (msg instanceof AIMessage) {
                    // Log tool calls
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        console.log("\n🔧 Tool Calls:");
                        for (const toolCall of msg.tool_calls) {
                            console.log(`  → ${toolCall.name}`);
                            console.log(`    Args: ${JSON.stringify(toolCall.args, null, 2).split('\n').join('\n    ')}`);
                        }
                    }

                    // Log LLM text response
                    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                        console.log("\n💬 Agent Response:");
                        console.log(`  ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`);
                    }
                }
            }
        }

        // Log tool results
        if (chunk.tools?.messages) {
            for (const msg of chunk.tools.messages) {
                if (msg instanceof ToolMessage) {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    console.log(`\n📤 Tool Result (${msg.name}):`);
                    console.log(`  ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}`);
                }
            }
        }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Code Comment Agent completed. Total steps: ${stepCount}`);
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
