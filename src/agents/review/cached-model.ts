/**
 * Claude prompt caching utilities for OpenRouter
 * 
 * Since LangChain doesn't natively support cache_control, we need to:
 * 1. Use a custom OpenAI client that modifies requests
 * 2. Inject cache_control into messages before they're sent
 */

import OpenAI from "openai";

/**
 * Create an OpenAI client that injects cache_control for Claude prompt caching
 */
export function createCachingOpenAIClient(apiKey: string, baseURL: string): OpenAI {
    const client = new OpenAI({
        apiKey,
        baseURL,
    });

    // Wrap the completions create method to inject cache_control
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);

    // @ts-ignore - we're patching the method
    client.chat.completions.create = async function (
        params: any,
        options?: any
    ) {
        // Inject cache_control into messages
        const modifiedMessages = (params.messages as any[]).map((msg: any, index: number) => {
            // Cache system (index 0) and first user message (index 1)
            const shouldCache =
                (msg.role === "system" && index === 0) ||
                (msg.role === "user" && index === 1);

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
        };

        // Log that we're using caching (debug)
        console.log("🔄 Prompt caching enabled for Claude");

        try {
            return await originalCreate(modifiedParams, options);
        } catch (error: any) {
            console.error("❌ OpenRouter API Error:");
            // Log the full error object for debugging
            if (error.response) {
                console.error("Response status:", error.response.status);
                console.error("Response data:", JSON.stringify(error.response.data, null, 2));
            } else if (error.error) {
                console.error("Error details:", JSON.stringify(error.error, null, 2));
            } else {
                console.error("Error:", JSON.stringify(error, null, 2));
            }
            throw error;
        }
    };

    return client;
}

/**
 * Create a ChatOpenAI instance with prompt caching support
 */
import { ChatOpenAI } from "@langchain/openai";

export function createCachedChatOpenAI() {
    // Create the caching client
    const cachingClient = createCachingOpenAIClient(
        process.env.OPENROUTER_KEY!,
        "https://openrouter.ai/api/v1"
    );

    // Create ChatOpenAI with custom client
    return new ChatOpenAI({
        modelName: process.env.MODEL!,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        apiKey: process.env.OPENROUTER_KEY!,
        // @ts-ignore - Pass the custom client
        client: cachingClient,
    });
}
