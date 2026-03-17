import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getPRDiff } from "../context/github.js";
import { truncateDiffPart } from "../agents/review/index.js";

/**
 * Tool to fetch the full PR diff for a specific file.
 * Useful during incremental reviews when the context diff only shows
 * changes since the last review.
 */
export const getFileDiffTool = tool(
    async ({ file_path }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const prNumber = parseInt(process.env.PR_NUMBER!, 10);

        try {
            const fullDiff = await getPRDiff(owner, repo, prNumber);

            // Split by file sections and find the matching one
            const parts = fullDiff.split(/(?=^diff --git )/m);
            for (const part of parts) {
                if (!part.trim()) continue;
                const headerLine = part.split('\n')[0];
                const match = headerLine.match(/diff --git a\/(.*?) b\//);
                if (match && match[1] === file_path) {
                    return `=== Full PR diff for ${file_path} ===\n${truncateDiffPart(part)}`;
                }
            }

            return `No diff found for file "${file_path}" in this PR. The file may not have been changed, or the path may be incorrect.`;
        } catch (error) {
            console.error(`Error fetching file diff for ${file_path}:`, error);
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error fetching file diff: ${message}`;
        }
    },
    {
        name: "get_file_diff",
        description:
            "Get the full PR diff for a specific file. During incremental re-reviews, the main diff only shows changes since the last review. Use this tool to see the complete diff of any file across the entire PR for broader context.",
        schema: z.object({
            file_path: z
                .string()
                .describe("The path of the file to get the full PR diff for (e.g., 'src/index.ts')."),
        }),
    }
);
