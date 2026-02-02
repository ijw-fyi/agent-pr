import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getOctokit, readFileContent } from "../context/github.js";

// Common code file extensions
const CODE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'scala',
    'c', 'cpp', 'cc', 'h', 'hpp', 'cs',
    'php', 'swift', 'm', 'mm',
    'sh', 'bash', 'zsh', 'fish',
    'sql', 'graphql', 'gql',
    'html', 'css', 'scss', 'sass', 'less',
    'json', 'yaml', 'yml', 'toml', 'xml',
    'md', 'mdx', 'txt', 'rst',
    'vue', 'svelte', 'astro',
    'dockerfile', 'makefile', 'cmake',
]);

function isCodeFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const basename = filename.toLowerCase();
    return CODE_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(basename);
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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

            // Format with size and LOC for code files
            const items = await Promise.all(sorted.map(async item => {
                if (item.type === 'dir') {
                    return `📁 ${item.name}/`;
                }

                const size = item.size ?? 0;
                const sizeStr = formatSize(size);

                // For code files, try to get LOC
                if (isCodeFile(item.name) && size > 0 && size < 500_000) {
                    try {
                        const filePath = normalizedPath ? `${normalizedPath}/${item.name}` : item.name;
                        const content = await readFileContent(owner, repo, filePath, ref);
                        const loc = content.split('\n').length;
                        return `   ${item.name} (${sizeStr}, ${loc} lines)`;
                    } catch {
                        // Fall back to size only
                        return `   ${item.name} (${sizeStr})`;
                    }
                }

                return `   ${item.name} (${sizeStr})`;
            }));

            const header = normalizedPath ? `Contents of ${normalizedPath}/` : 'Repository root:';
            return `${header}\n\n${items.join('\n')}`;
        } catch (error: any) {
            console.error(`❌ Error in list_directory:`, error);
            if (error.status === 404) {
                return `Error: Directory '${path}' not found`;
            }
            return `Error listing directory ${path}: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "list_directory",
        description:
            "List the contents of a directory in the repository. Returns files and subdirectories with file sizes and line counts for code files. Use this to explore the project structure.",
        schema: z.object({
            path: z
                .string()
                .describe("Directory path relative to repository root. Use '' or '/' for root directory."),
        }),
    }
);
