/**
 * Shared helpers for processing agent stream chunks
 * Uses GitHub Actions log groups for collapsible output
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createCachedChatOpenAI, isOverBudget, getRunningCost, getBudget, recordToolCall } from "./cached-model.js";

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
                const failed = content.startsWith('Error');

                // Record tool usage
                if (msg.name) {
                    recordToolCall(msg.name, failed);
                }

                console.log(`::group::[Step ${stepNum}] 🔧 tool:${msg.name} | ${formatCost()} | ${preview}`);
                console.log(content);
                console.log("::endgroup::");
            }
        }
    }
}

/**
 * Options for streamWithBudget
 */
export interface StreamWithBudgetOptions {
    /** Agent name for cost tracking and log prefix */
    agentName: string;
    /** Tools for both main and wrap-up agents */
    tools: StructuredToolInterface[];
    /** Messages to stream (mutated in place with new messages) */
    messages: BaseMessage[];
    /** Recursion limit for the main stream */
    recursionLimit: number;
    /** Budget exceeded wrap-up message injected as HumanMessage */
    wrapUpMessage: string;
    /** Optional reduced tool set for the wrap-up agent. Defaults to `tools`. */
    wrapUpTools?: StructuredToolInterface[];
    /** Optional callback on each chunk (e.g., to capture lastAIContent) */
    onChunk?: (chunk: any) => void;
}

export interface StreamWithBudgetResult {
    stepCount: number;
    abortedForBudget: boolean;
}

/**
 * Stream an agent with budget monitoring and automatic wrap-up.
 *
 * Creates a ReAct agent, streams it with budget checks on each step,
 * and if the budget is exceeded mid-investigation, injects a wrap-up
 * message and runs a final pass to let the agent finish gracefully.
 */
export async function streamWithBudget(opts: StreamWithBudgetOptions): Promise<StreamWithBudgetResult> {
    const { agentName, tools, messages, recursionLimit, wrapUpMessage, wrapUpTools, onChunk } = opts;
    const budget = getBudget();
    const prefix = `[${agentName}] `;

    const model = createCachedChatOpenAI(agentName);
    const agent = createReactAgent({ llm: model, tools });

    const abortController = new AbortController();
    const stream = await agent.stream(
        { messages },
        { recursionLimit, signal: abortController.signal },
    );

    let stepCount = 0;
    let budgetExceeded = false;
    let abortedForBudget = false;

    for await (const chunk of stream) {
        stepCount++;
        processChunk(chunk, stepCount, messages);
        onChunk?.(chunk);

        if (!budgetExceeded && isOverBudget()) {
            budgetExceeded = true;
            const cost = getRunningCost();
            console.log(`\n⚠️ ${prefix}Budget exceeded ($${cost.toFixed(4)} / $${budget.toFixed(2)}) - wrapping up`);
        }

        if (budgetExceeded && chunk.tools?.messages) {
            console.log(`\n📝 ${prefix}Injecting wrap-up message after tool results...`);
            messages.push(new HumanMessage(wrapUpMessage));
            abortedForBudget = true;
            abortController.abort();
            break;
        }
    }

    if (abortedForBudget) {
        console.log(`\n📝 ${prefix}Running wrap-up pass...`);
        const wrapUpModel = createCachedChatOpenAI(agentName);
        const wrapUpAgent = createReactAgent({ llm: wrapUpModel, tools: wrapUpTools ?? tools });

        try {
            const wrapUpStream = await wrapUpAgent.stream(
                { messages },
                { recursionLimit: 20 },
            );

            for await (const chunk of wrapUpStream) {
                stepCount++;
                processChunk(chunk, stepCount, messages);
                onChunk?.(chunk);
            }
            console.log(`📝 ${prefix}Wrap-up complete`);
        } catch (error) {
            console.error(`${prefix}Wrap-up error:`, error);
        }
    }

    return { stepCount, abortedForBudget };
}
