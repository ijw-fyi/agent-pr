import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { COMMENT_REPLY_PROMPT } from "./prompt.js";
import { storePreferenceTool } from "../../tools/store-preference.js";
import { replyToCommentTool } from "../../tools/reply-to-comment.js";
import { tools as reviewTools } from "../../tools/index.js";
import { readPreferences } from "../../preferences/index.js";
import { resetRunningCost, getBudget, logRunStats } from "../../helpers/cached-model.js";
import { streamWithBudget } from "../../helpers/stream-utils.js";
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

// Tools that only make sense during a full PR review, not in comment reply mode.
const REVIEW_ONLY_TOOLS = new Set(["leave_comment", "submit_review"]);

/**
 * Get the tools available to the comment reply agent.
 * Includes shared tools (read_files, grep, etc.) and MCP tools, but filters out
 * review-only tools (leave_comment, submit_review) that could cause the agent
 * to act outside the scope of the comment thread.
 */
function getCommentReplyTools(): StructuredToolInterface[] {
    return [
        storePreferenceTool,
        replyToCommentTool,
        ...reviewTools.filter(t => !REVIEW_ONLY_TOOLS.has(t.name)),
    ];
}

/**
 * Run the comment reply agent
 */
export async function runCommentReplyAgent(
    context: CommentReplyContext,
    recursionLimit: number = 100
): Promise<void> {
    // Reset cost tracking for this run
    resetRunningCost();
    const budget = getBudget();
    console.log(`💵 Budget: $${budget.toFixed(2)}`);

    // Get tools for the agent
    const tools = getCommentReplyTools();

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

    // Stream the agent execution with budget monitoring
    const allMessages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(contextMessage),
    ];

    const { stepCount } = await streamWithBudget({
        agentName: "comment_reply",
        tools,
        messages: allMessages,
        recursionLimit,
        wrapUpMessage: "IMPORTANT BUDGET NOTICE: You are past your budget limit. STOP exploring the code immediately. Compile your findings and respond to the user or save any preferences you've identified.",
    });

    logRunStats("Comment Reply Agent", stepCount);
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
