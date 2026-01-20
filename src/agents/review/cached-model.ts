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

/**
 * Patch an OpenAI client to inject cache_control into messages
 */
function patchOpenAIClient(client: any) {
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);

    client.chat.completions.create = async function (params: any, options?: any) {
        console.log("🔄 Sending request with prompt caching");

        // Find the last user message index
        const messages = params.messages as any[];
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
                lastUserIndex = i;
                break;
            }
        }

        // Inject cache_control into messages
        const modifiedMessages = messages.map((msg: any, index: number) => {
            // Cache: system (index 0), first user (index 1), and last user message
            const shouldCache =
                (msg.role === "system" && index === 0) ||
                (msg.role === "user" && index === 1) ||
                (msg.role === "user" && index === lastUserIndex && index > 1);

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

        try {
            return await originalCreate(modifiedParams, options);
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
            throw error;
        }
    };
}
