/**
 * Shared helpers for processing agent stream chunks
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";

/**
 * Process and log a stream chunk from an agent
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
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Step ${stepNum}`);
    console.log("─".repeat(60));

    if (chunk.agent?.messages) {
        for (const msg of chunk.agent.messages) {
            allMessages.push(msg);
            if (msg instanceof AIMessage) {
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    console.log("\n🔧 Tool Calls:");
                    for (const toolCall of msg.tool_calls) {
                        console.log(`  → ${toolCall.name}`);
                        console.log(`    Args: ${JSON.stringify(toolCall.args, null, 2).split('\n').join('\n    ')}`);
                    }
                }
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    console.log("\n💬 Agent Response:");
                    console.log(`  ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`);
                }
            }
        }
    }

    if (chunk.tools?.messages) {
        for (const msg of chunk.tools.messages) {
            allMessages.push(msg);
            if (msg instanceof ToolMessage) {
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                console.log(`\n📤 Tool Result (${msg.name}):`);
                console.log(`  ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}`);
            }
        }
    }
}
