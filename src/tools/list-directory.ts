import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getOctokit } from "../context/github.js";

/**
 * Tool to list contents of a directory in the repository
 */
export const listDirectoryTool = tool(
    async ({ path }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const ref = process.env.HEAD_SHA!;
        const octokit = getOctokit();

        try {
            // Normalize path - remove leading/trailing slashes
            const normalizedPath = path.replace(/^\/+|\/+$/g, '') || '';

            const { data } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: normalizedPath,
                ref,
            });

            // getContent returns array for directories
            if (!Array.isArray(data)) {
                return `Error: '${path}' is not a directory`;
            }

            // Sort: directories first, then files
            const sorted = data.sort((a, b) => {
                if (a.type === 'dir' && b.type !== 'dir') return -1;
                if (a.type !== 'dir' && b.type === 'dir') return 1;
                return a.name.localeCompare(b.name);
            });

            // Format as simple list
            const items = sorted.map(item => {
                if (item.type === 'dir') {
                    return `📁 ${item.name}/`;
                }
                return `   ${item.name}`;
            });

            const header = normalizedPath ? `Contents of ${normalizedPath}/` : 'Repository root:';
            return `${header}\n\n${items.join('\n')}`;
        } catch (error: any) {
            if (error.status === 404) {
                return `Error: Directory '${path}' not found`;
            }
            return `Error listing directory ${path}: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "list_directory",
        description:
            "List the contents of a directory in the repository. Returns files and subdirectories. Use this to explore the project structure.",
        schema: z.object({
            path: z
                .string()
                .describe("Directory path relative to repository root. Use '' or '/' for root directory."),
        }),
    }
);
