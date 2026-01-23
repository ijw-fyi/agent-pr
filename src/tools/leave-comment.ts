import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createReviewComment } from "../context/github.js";

/**
 * Tool to leave inline comments on PR code
 */
export const leaveCommentTool = tool(
    async ({ path, line, body, side, startLine }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);
        const commitId = process.env.HEAD_SHA!;

        try {
            await createReviewComment(
                owner,
                repo,
                prNumber,
                commitId,
                path,
                line,
                body,
                (side ?? "RIGHT") as "LEFT" | "RIGHT",
                startLine ?? undefined
            );

            const lineDesc = startLine
                ? `lines ${startLine}-${line}`
                : `line ${line}`;

            return `Successfully left comment on ${path} at ${lineDesc}`;
        } catch (error) {
            console.error(`❌ Error in leave_comment:`, error);
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error leaving comment on ${path}: ${message}`;
        }
    },
    {
        name: "leave_comment",
        description:
            "Leave an inline review comment on a specific line or range of lines in a file. Use this to point out issues, bugs, or suggestions directly on the code.",
        schema: z.object({
            path: z
                .string()
                .describe("File path relative to repository root (e.g., 'src/index.ts')"),
            line: z
                .number()
                .describe(
                    "Line number to comment on (1-indexed). For multi-line comments, this is the ending line."
                ),
            body: z
                .string()
                .describe(
                    "The comment text in Markdown format. Include the issue description and suggested fix."
                ),
            side: z
                .enum(["LEFT", "RIGHT"])
                .optional()
                .nullable()
                .default("RIGHT")
                .describe(
                    "Which side of the diff to comment on. RIGHT for additions (green), LEFT for deletions (red). Usually RIGHT."
                ),
            startLine: z
                .number()
                .optional()
                .nullable()
                .describe(
                    "For multi-line comments: the starting line number. Must be less than 'line' parameter."
                ),
        }),
    }
);
