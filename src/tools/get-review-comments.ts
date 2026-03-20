/**
 * Tool to fetch review comments posted by sibling agents during the current review run.
 * Used by orchestrated sub-agents to avoid posting duplicate comments.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getReviewComments } from "../context/github.js";

export const getReviewCommentsTool = tool(
    async () => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);
        const reviewStartTime = process.env.REVIEW_START_TIME;
        const botLogin = process.env.PR_AGENT_BOT_LOGIN;

        try {
            const comments = await getReviewComments(owner, repo, prNumber);

            // Filter to bot comments posted during this review run
            const filtered = comments.filter(c => {
                if (botLogin && c.author !== botLogin) return false;
                if (reviewStartTime && new Date(c.createdAt) < new Date(reviewStartTime)) return false;
                return true;
            });

            if (filtered.length === 0) {
                return "No review comments have been posted by sibling agents yet.";
            }

            return filtered.map(c =>
                `[${c.path}:${c.line ?? "file-level"}] ${c.body.substring(0, 200)}${c.body.length > 200 ? "..." : ""}`
            ).join("\n\n");
        } catch (error) {
            console.error("❌ Error in get_review_comments:", error);
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error fetching review comments: ${message}`;
        }
    },
    {
        name: "get_review_comments",
        description:
            "Fetch inline review comments posted by sibling agents during this review run. Use this BEFORE calling leave_comment to check if another agent already flagged the same issue on the same file and line area. Returns a list of comments with file path, line number, and body.",
        schema: z.object({}),
    }
);
