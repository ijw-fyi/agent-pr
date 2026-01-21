import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { replyToReviewComment } from "../context/github.js";

/**
 * Tool to reply to a code review comment thread
 */
export const replyToCommentTool = tool(
    async ({ body }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);
        const commentId = process.env.COMMENT_ID ? parseInt(process.env.COMMENT_ID, 10) : null;

        if (!commentId) {
            return "Error: No comment ID available - cannot reply to comment thread";
        }

        try {
            await replyToReviewComment(owner, repo, prNumber, commentId, body);
            return `Successfully replied to comment thread`;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error replying to comment: ${message}`;
        }
    },
    {
        name: "reply_to_comment",
        description:
            "Reply to the current code review comment thread. Use this to respond to the user's message, ask clarifying questions, or continue the conversation. Only call this if you have something meaningful to add.",
        schema: z.object({
            body: z
                .string()
                .describe(
                    "The reply content in Markdown format. Be concise and helpful."
                ),
        }),
    }
);
