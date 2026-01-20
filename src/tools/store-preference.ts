import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { appendPreference } from "../preferences/index.js";
import { createPRComment } from "../context/github.js";

/**
 * Tool to store a user preference
 */
export const storePreferenceTool = tool(
    async ({ preference }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);

        try {
            await appendPreference(owner, repo, preference);

            // Leave a comment notifying about the preference update
            const comment = `🧠 **Preference Learned**

I've noted the following preference for future reviews:

> ${preference}

This has been saved to the \`__agent_pr__\` branch and will be considered in future code reviews.`;

            await createPRComment(owner, repo, prNumber, comment);

            return `Successfully stored preference: "${preference}" and notified on PR`;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error storing preference: ${message}`;
        }
    },
    {
        name: "store_preference",
        description:
            "Store a coding preference extracted from the user's reply. This will be remembered for future code reviews.",
        schema: z.object({
            preference: z
                .string()
                .describe(
                    "A clear, reusable preference statement. Should be general enough to apply to future reviews. Example: 'Prefer async/await over .then() chains'"
                ),
        }),
    }
);
