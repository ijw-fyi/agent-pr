import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Placeholder tool for web search
 * TODO: Implement actual web search functionality
 */
export const searchWebTool = tool(
    async ({ query }) => {
        // Placeholder implementation
        return `Web search is not yet implemented. Query was: "${query}"\n\nPlease rely on the repository context and your training knowledge for now.`;
    },
    {
        name: "search_web",
        description:
            "Search the web for information. (Note: This is a placeholder and will be implemented later)",
        schema: z.object({
            query: z
                .string()
                .describe("The search query to look up on the web"),
        }),
    }
);
