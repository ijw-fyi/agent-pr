import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PREFERENCE_PROMPT } from "./prompt.js";
import { storePreferenceTool } from "../../tools/store-preference.js";
import { readPreferences } from "../../preferences/index.js";

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
 * Run the preference extraction agent
 */
export async function runPreferenceAgent(
    context: PreferenceContext
): Promise<void> {
    // Create the model with OpenRouter backend
    const model = new ChatOpenAI({
        modelName: process.env.MODEL!,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        apiKey: process.env.OPENROUTER_KEY!,
    });

    // Create agent with just the store_preference tool
    const agent = createReactAgent({
        llm: model,
        tools: [storePreferenceTool],
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
    console.log("Starting Preference Agent");
    console.log("=".repeat(60));
    console.log(`File: ${context.filePath}`);
    console.log(`Comments in chain: ${context.commentChain.length}`);
    console.log("=".repeat(60));

    // Run the agent
    const result = await agent.invoke({
        messages: [
            new SystemMessage(systemPrompt),
            new HumanMessage(contextMessage),
        ],
    });

    // Log the result
    const lastMessage = result.messages[result.messages.length - 1];
    console.log("\nAgent result:");
    console.log(lastMessage.content);
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
Analyze the user's reply. If it reveals a coding preference that should be remembered for future reviews, use the store_preference tool. Otherwise, just respond that no preference was detected.
`;
}
