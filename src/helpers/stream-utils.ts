/**
 * Shared helpers for processing agent stream chunks
 * Uses GitHub Actions log groups for collapsible output
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { getRunningCost } from "./cached-model.js";

/**
 * Truncate text to specified length, adding ellipsis if needed
 */
function truncate(text: string, maxLen: number): string {
    const cleaned = text.replace(/\n/g, ' ').trim();
    return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + '...' : cleaned;
}

/**
 * Format cost as string
 */
function formatCost(): string {
    const cost = getRunningCost();
    return `$${cost.toFixed(4)}`;
}

/**
 * Process and log a stream chunk from an agent
 * Uses GitHub Actions ::group:: for collapsible logs
 * 
 * @param chunk - The stream chunk from agent.stream()
 * @param stepNum - Current step number for logging
 * @param allMessages - Array to collect messages for history preservation
 */
export function processChunk(
    chunk: any,
    stepNum: number,
    allMessages: any[]
): void {
    if (chunk.agent?.messages) {
        for (const msg of chunk.agent.messages) {
            allMessages.push(msg);
            if (msg instanceof AIMessage) {
                const content = typeof msg.content === 'string' ? msg.content.trim() : '';
                const toolCount = msg.tool_calls?.length || 0;
                const toolInfo = toolCount > 0 ? ` | ${toolCount} tool${toolCount > 1 ? 's' : ''}` : '';
                const preview = content ? truncate(content, 100) : (toolCount > 0 ? msg.tool_calls!.map(t => t.name).join(', ') : '(no content)');

                console.log(`::group::[Step ${stepNum}] 🤖 assistant | ${formatCost()}${toolInfo} | ${preview}`);

                if (content) {
                    console.log("\n💬 Response:");
                    console.log(content);
                }

                if (toolCount > 0) {
                    console.log("\n🔧 Tool Calls:");
                    for (const toolCall of msg.tool_calls!) {
                        console.log(`  → ${toolCall.name}`);
                        console.log(`    Args: ${JSON.stringify(toolCall.args, null, 2).split('\n').join('\n    ')}`);
                    }
                }

                console.log("::endgroup::");
            }
        }
    }

    if (chunk.tools?.messages) {
        for (const msg of chunk.tools.messages) {
            allMessages.push(msg);
            if (msg instanceof ToolMessage) {
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                const preview = truncate(content, 100);

                console.log(`::group::[Step ${stepNum}] 🔧 tool:${msg.name} | ${formatCost()} | ${preview}`);
                console.log(content);
                console.log("::endgroup::");
            }
        }
    }
}
