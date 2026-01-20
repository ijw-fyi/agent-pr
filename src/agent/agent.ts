import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { tools } from "../tools/index.js";
import type { PRContext } from "../context/types.js";

/**
 * Run the PR review agent with the given context
 */
export async function runReview(context: PRContext): Promise<void> {
    // Create the model with OpenRouter backend
    const model = new ChatOpenAI({
        modelName: process.env.MODEL!,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        apiKey: process.env.OPENROUTER_KEY!,
    });

    // Create the React agent
    const agent = createReactAgent({
        llm: model,
        tools,
    });

    // Build the initial context message
    const contextMessage = buildContextMessage(context);

    console.log("=".repeat(60));
    console.log("Starting PR Review Agent");
    console.log("=".repeat(60));
    console.log(`Model: ${process.env.MODEL}`);
    console.log(`Tools available: ${tools.map(t => t.name).join(", ")}`);
    console.log("=".repeat(60));

    console.log("\n📝 User Context Message:");
    console.log("─".repeat(60));
    console.log(contextMessage);
    console.log("─".repeat(60));

    // Stream the agent execution to log each step
    let stepCount = 0;
    const stream = await agent.stream({
        messages: [
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage(contextMessage),
        ],
    });

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
    console.log(`Review completed. Total steps: ${stepCount}`);
    console.log("=".repeat(60));
}

/**
 * Build the context message for the agent
 */
function buildContextMessage(context: PRContext): string {
    let message = `# Pull Request Review Request

## PR Information
- **Title**: ${context.title}
- **Author**: ${context.author}
- **Branch**: ${context.headBranch} → ${context.baseBranch}

## PR Description
${context.description || "(No description provided)"}

## Changed Files Diff
\`\`\`diff
${context.diff}
\`\`\`

## Project File Tree
\`\`\`
${context.fileTree}
\`\`\`
`;

    if (context.existingComments.length > 0) {
        message += `
## Existing Review Comments
${context.existingComments.map((c) => `- **${c.author}** on \`${c.path}\`: ${c.body}`).join("\n")}
`;
    }

    if (context.conversation.length > 0) {
        message += `
## PR Conversation
${context.conversation.map((c) => `- **${c.author}**: ${c.body}`).join("\n")}
`;
    }

    message += `
## Your Task
Please review this pull request thoroughly. Use the tools available to:
1. Read any files you need more context on
2. Leave inline comments on specific lines where you find issues
3. Submit your final review with a summary when done

Begin your review now.
`;

    return message;
}
