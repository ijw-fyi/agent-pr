import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getCommitDiff } from "../context/github.js";

/**
 * Tool to fetch the diff for a specific commit
 */
export const getCommitDiffTool = tool(
    async ({ commit_sha }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;

        try {
            const diff = await getCommitDiff(owner, repo, commit_sha);

            if (!diff || diff.trim().length === 0) {
                return `No diff found for commit ${commit_sha}. The commit may be empty or a merge commit.`;
            }

            const truncated = truncateCommitDiff(diff);
            return `=== Diff for commit ${commit_sha.substring(0, 7)} ===\n${truncated}`;
        } catch (error) {
            console.error(`Error fetching diff for commit ${commit_sha}:`, error);
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error fetching commit diff: ${message}`;
        }
    },
    {
        name: "get_commit_diff",
        description:
            "Fetch the diff for a specific commit by SHA. Use this to inspect individual commits when you need to understand what a particular commit changed, rather than looking at the full PR diff.",
        schema: z.object({
            commit_sha: z
                .string()
                .describe("The full or abbreviated SHA of the commit to fetch the diff for."),
        }),
    }
);

/**
 * Truncate a commit diff to avoid overwhelming context.
 */
function truncateCommitDiff(diff: string): string {
    const MAX_LINES_PER_FILE = 500;
    const MAX_CHARS_PER_FILE = 40000;

    const parts = diff.split(/(?=^diff --git )/m);

    return parts.map(part => {
        if (!part.trim()) return part;

        if (part.length > MAX_CHARS_PER_FILE) {
            return part.slice(0, MAX_CHARS_PER_FILE) + "\n... (File diff truncated)\n";
        }

        const lines = part.split('\n');
        if (lines.length > MAX_LINES_PER_FILE) {
            return lines.slice(0, MAX_LINES_PER_FILE).join('\n') + "\n... (File diff truncated)\n";
        }

        return part;
    }).join('');
}
