import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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

    // Invoke the agent
    const result = await agent.invoke({
        messages: [
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage(contextMessage),
        ],
    });

    console.log("Review completed. Final message count:", result.messages.length);
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
