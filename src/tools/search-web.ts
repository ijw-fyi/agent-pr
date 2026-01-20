import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

/**
 * Tool for web search using Gemini API with Google Search grounding
 */
export const searchWebTool = tool(
    async ({ query }) => {
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return `Web search is not available. GEMINI_API_KEY is not configured.`;
        }

        try {
            const ai = new GoogleGenAI({ apiKey });

            const config = {
                thinkingConfig: {
                    thinkingLevel: ThinkingLevel.MEDIUM,
                },
                tools: [
                    { urlContext: {} },
                    { codeExecution: {} },
                    { googleSearch: {} },
                ],
            };

            const response = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                config,
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: `Search the web for the following query and provide a comprehensive summary of the results. Focus on the most relevant and recent information.\n\nQuery: ${query}`,
                            },
                        ],
                    },
                ],
            });

            // Extract text from response
            const candidate = response.candidates?.[0];
            if (!candidate?.content?.parts) {
                return `No search results found for: "${query}"`;
            }

            const textParts = candidate.content.parts
                .filter((part: { text?: string }) => part.text)
                .map((part: { text?: string }) => part.text)
                .join("\n");

            if (!textParts) {
                return `No search results found for: "${query}"`;
            }

            // Extract sources from grounding metadata
            const groundingMetadata = candidate.groundingMetadata;
            const groundingChunks = groundingMetadata?.groundingChunks;

            let sourcesText = "";
            if (groundingChunks && groundingChunks.length > 0) {
                const sources = groundingChunks
                    .map((chunk: { web?: { uri?: string; title?: string } }, index: number) => {
                        if (chunk.web?.uri) {
                            const title = chunk.web.title || chunk.web.uri;
                            return `[${index + 1}] ${title}: ${chunk.web.uri}`;
                        }
                        return null;
                    })
                    .filter(Boolean);

                if (sources.length > 0) {
                    sourcesText = `\n\nSources:\n${sources.join("\n")}`;
                }
            }

            return `Web search results for "${query}":\n\n${textParts}${sourcesText}`;
        } catch (error) {
            return `Error performing web search: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "search_web",
        description:
            "Search the web for information using Google Search. Use this to find documentation, best practices, or context about libraries and technologies.",
        schema: z.object({
            query: z
                .string()
                .describe("The search query to look up on the web"),
        }),
    }
);

/**
 * Check if web search is available (GEMINI_API_KEY is set)
 */
export function isWebSearchAvailable(): boolean {
    return !!process.env.GEMINI_API_KEY;
}
