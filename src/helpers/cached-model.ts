/**
 * Claude prompt caching utilities for OpenRouter
 * 
 * Since LangChain doesn't natively support cache_control, we need to:
 * 1. Create a ChatOpenAI instance
 * 2. Intercept client creation to patch it before first use
 */

import { ChatOpenAI } from "@langchain/openai";

/**
 * Create a ChatOpenAI instance with prompt caching support
 * 
 * This works by patching _getClientOptions to intercept client creation
 * and patch the client's chat.completions.create method
 */
export function createCachedChatOpenAI(): ChatOpenAI {
    const model = new ChatOpenAI({
        modelName: process.env.MODEL!,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        apiKey: process.env.OPENROUTER_KEY!,
    });

    // Flag to track if we've patched the client
    let clientPatched = false;

    // Override _getClientOptions to patch the client right after it's created
    // @ts-ignore - accessing internal method
    const originalGetClientOptions = model._getClientOptions.bind(model);

    // @ts-ignore - patching internal method
    model._getClientOptions = function (options: any) {
        const result = originalGetClientOptions(options);

        // Patch the client if it exists and hasn't been patched
        // @ts-ignore
        if (this.client && !clientPatched) {
            // @ts-ignore
            patchOpenAIClient(this.client);
            clientPatched = true;
            console.log("✅ Prompt caching client patched");
        }

        return result;
    };

    return model;
}

// Running totals across all requests
let runningCostTotal = 0;
let runningInputTokens = 0;
let runningOutputTokens = 0;
let runningCacheReadTokens = 0;
let runningCacheWriteTokens = 0;
let callCount = 0;

/**
 * Get the current running cost total
 */
export function getRunningCost(): number {
    return runningCostTotal;
}

/**
 * Get the current running input tokens
 */
export function getRunningInputTokens(): number {
    return runningInputTokens;
}

/**
 * Get the current running output tokens
 */
export function getRunningOutputTokens(): number {
    return runningOutputTokens;
}

/**
 * Get the current running cache read tokens
 */
export function getRunningCacheReadTokens(): number {
    return runningCacheReadTokens;
}

/**
 * Get the current running cache write tokens
 */
export function getRunningCacheWriteTokens(): number {
    return runningCacheWriteTokens;
}

/**
 * Reset running totals (call at start of new agent run)
 */
export function resetRunningCost(): void {
    runningCostTotal = 0;
    runningInputTokens = 0;
    runningOutputTokens = 0;
    runningCacheReadTokens = 0;
    runningCacheWriteTokens = 0;
    callCount = 0;
}

/**
 * Get the budget limit from env var, defaults to $1.00 USD
 */
export function getBudget(): number {
    const budgetStr = process.env.AGENT_PR_BUDGET;
    if (budgetStr) {
        const parsed = parseFloat(budgetStr);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return 1.0; // Default $1 USD
}

/**
 * Check if current cost exceeds budget
 */
export function isOverBudget(): boolean {
    return runningCostTotal >= getBudget();
}

/**
 * Patch an OpenAI client to inject cache_control into messages
 */
function patchOpenAIClient(client: any) {
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);

    client.chat.completions.create = async function (params: any, options?: any) {
        // Don't support streaming
        if (params.stream) {
            throw new Error("Streaming is not supported");
        }

        callCount++;
        console.log(`::group::[Call ${callCount} - Stats] OpenRouter API Request`);
        console.log("🔄 Sending request with prompt caching");

        // Debug: show message roles
        const messages = params.messages as any[];
        console.log(`   Messages: ${messages.map((m: any) => m.role).join(' → ')}`);

        // Find the last user and tool message indices
        let lastUserIndex = -1;
        let lastToolIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user" && lastUserIndex === -1) {
                lastUserIndex = i;
            }
            if (messages[i].role === "tool" && lastToolIndex === -1) {
                lastToolIndex = i;
            }
            if (lastUserIndex !== -1 && lastToolIndex !== -1) break;
        }

        // Inject cache_control into messages
        const modifiedMessages = messages.map((msg: any, index: number) => {
            // Cache: system (index 0), first user (index 1), last user, and last tool message
            const shouldCache =
                (msg.role === "system" && index === 0) ||
                (msg.role === "user" && index === 1) ||
                (msg.role === "user" && index === lastUserIndex && index > 1) ||
                (msg.role === "tool" && index === lastToolIndex);

            if (shouldCache) {
                // For string content, wrap it in array format with cache_control
                if (typeof msg.content === "string") {
                    return {
                        ...msg,
                        content: [
                            {
                                type: "text",
                                text: msg.content,
                                cache_control: { type: "ephemeral" }
                            }
                        ]
                    };
                }
                // For array content, add cache_control to last element
                if (Array.isArray(msg.content)) {
                    const lastIdx = msg.content.length - 1;
                    return {
                        ...msg,
                        content: msg.content.map((block: any, i: number) =>
                            i === lastIdx
                                ? { ...block, cache_control: { type: "ephemeral" } }
                                : block
                        )
                    };
                }
            }
            return msg;
        });

        const modifiedParams = {
            ...params,
            messages: modifiedMessages,
            // OpenRouter reasoning config (medium effort)
            // @ts-ignore
            reasoning: {
                effort: "medium"
            },
            // Enable usage accounting to get cost info
            usage: {
                include: true
            },
        };

        try {
            const response = await originalCreate(modifiedParams, options);

            // Log cache stats and cost from the raw response
            const usage = response?.usage as any;
            if (usage) {
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                runningInputTokens += inputTokens;
                runningOutputTokens += outputTokens;
                console.log(`📊 API Usage: ${inputTokens} in, ${outputTokens} out | Total: ${runningInputTokens} in, ${runningOutputTokens} out`);
                if (usage.prompt_tokens_details) {
                    const details = usage.prompt_tokens_details;
                    const write = details.cache_write_tokens || 0;
                    const read = details.cached_tokens || 0;
                    runningCacheWriteTokens += write;
                    runningCacheReadTokens += read;
                    if (write > 0 || read > 0) {
                        console.log(`   Cache: ${write > 0 ? `📝 Write ${write}` : ''}${write > 0 && read > 0 ? ', ' : ''}${read > 0 ? `📖 Read ${read}` : ''} tokens`);
                    }
                }
                // Log cost info
                // For BYOK: cost = OpenRouter fee (5%), upstream = provider cost
                // For non-BYOK: cost = total (provider + OpenRouter)
                const cost = usage.cost ?? usage.total_cost ?? 0;
                const upstreamCost = usage.cost_details?.upstream_inference_cost ?? 0;
                // Sum both for total actual cost
                const effectiveCost = cost + upstreamCost;
                if (effectiveCost > 0) {
                    runningCostTotal += effectiveCost;
                    const costStr = `$${effectiveCost.toFixed(6)}`;
                    const breakdown = upstreamCost > 0
                        ? ` (provider: $${upstreamCost.toFixed(6)} + router: $${cost.toFixed(6)})`
                        : '';
                    console.log(`💰 Cost: ${costStr}${breakdown} | Running total: $${runningCostTotal.toFixed(6)}`);
                }
            }

            // Log thinking/reasoning if present
            const choice = response?.choices?.[0]?.message as any;
            if (choice?.reasoning_details && Array.isArray(choice.reasoning_details)) {
                for (const detail of choice.reasoning_details) {
                    if (detail.type === 'reasoning.summary' && detail.summary) {
                        console.log(`🧠 Thinking Summary: ${detail.summary.substring(0, 500)}...`);
                    } else if (detail.type === 'reasoning.text' && detail.text) {
                        console.log(`🧠 Thinking: ${detail.text.substring(0, 1000)}... (${detail.text.length} chars)`);
                    }
                }
            } else if (choice?.reasoning) {
                // Fallback for older format
                console.log(`🧠 Thinking: ${choice.reasoning.substring(0, 1000)}... (${choice.reasoning.length} chars)`);
            }

            console.log("::endgroup::");
            return response;
        } catch (error: any) {
            console.error("❌ OpenRouter API Error:");
            if (error.response) {
                console.error("Response status:", error.response.status);
                console.error("Response data:", JSON.stringify(error.response.data, null, 2));
            } else if (error.error) {
                console.error("Error details:", JSON.stringify(error.error, null, 2));
            } else {
                console.error("Error:", JSON.stringify(error, null, 2));
            }
            console.log("::endgroup::");
            throw error;
        }
    };
}
