import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

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
    async ({ path: dirPath }) => {
        const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();

        try {
            // Normalize path - remove leading/trailing slashes
            const normalizedPath = dirPath.replace(/^\/+|\/+$/g, '') || '';
            const fullPath = path.join(workspaceRoot, normalizedPath);

            // Check if path exists and is a directory
            const stats = await fs.stat(fullPath);
            if (!stats.isDirectory()) {
                return `Error: '${dirPath}' is not a directory`;
            }

            // Read directory contents
            const entries = await fs.readdir(fullPath, { withFileTypes: true });

            // Sort: directories first, then files
            const sorted = entries.sort((a, b) => {
                const aIsDir = a.isDirectory() || a.isSymbolicLink();
                const bIsDir = b.isDirectory() || b.isSymbolicLink();
                if (aIsDir && !bIsDir) return -1;
                if (!aIsDir && bIsDir) return 1;
                return a.name.localeCompare(b.name);
            });

            // Format with size and LOC for code files
            const items = await Promise.all(sorted.map(async entry => {
                const entryPath = path.join(fullPath, entry.name);

                // Follow symlinks to determine actual type
                let isDir = entry.isDirectory();
                if (entry.isSymbolicLink()) {
                    try {
                        const targetStats = await fs.stat(entryPath);
                        isDir = targetStats.isDirectory();
                    } catch {
                        // Broken symlink, treat as file
                        return `   ${entry.name} (broken symlink)`;
                    }
                }

                if (isDir) {
                    return `📁 ${entry.name}/`;
                }

                try {
                    const fileStats = await fs.stat(entryPath);
                    const size = fileStats.size;
                    const sizeStr = formatSize(size);

                    // For code files, try to get LOC
                    if (isCodeFile(entry.name) && size > 0 && size < 500_000) {
                        try {
                            const content = await fs.readFile(entryPath, 'utf-8');
                            const loc = content.split('\n').length;
                            return `   ${entry.name} (${sizeStr}, ${loc} lines)`;
                        } catch {
                            // Fall back to size only
                            return `   ${entry.name} (${sizeStr})`;
                        }
                    }

                    return `   ${entry.name} (${sizeStr})`;
                } catch {
                    return `   ${entry.name}`;
                }
            }));

            const header = normalizedPath ? `Contents of ${normalizedPath}/` : 'Repository root:';
            return `${header}\n\n${items.join('\n')}`;
        } catch (error: unknown) {
            console.error(`❌ Error in list_directory:`, error);
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return `Error: Directory '${dirPath}' not found`;
            }
            return `Error listing directory ${dirPath}: ${error instanceof Error ? error.message : "Unknown error"}`;
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
