import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Tool to search for patterns in the codebase
 */
export const grepTool = tool(
    async ({ pattern, path: searchPath = ".", type = "exact_match", caseInsensitive = false, padding = 0 }) => {
        const results: string[] = [];
        const MAX_RESULTS = 50;
        const MAX_FILE_SIZE = 1024 * 1024; // 1MB

        try {
            // Validate start path
            try {
                await fs.access(searchPath);
            } catch {
                return `Error: Path '${searchPath}' does not exist`;
            }

            // Helper to recursively walk directory
            async function walk(currentPath: string) {
                if (results.length >= MAX_RESULTS) return;

                const contextPath = path.resolve(currentPath);

                // Skip hidden files/dirs (like .git)
                if (path.basename(contextPath).startsWith(".") && path.basename(contextPath) !== ".") {
                    return;
                }

                // Skip node_modules
                if (contextPath.includes("node_modules")) {
                    return;
                }

                const stats = await fs.stat(contextPath);

                if (stats.isDirectory()) {
                    const entries = await fs.readdir(contextPath);
                    for (const entry of entries) {
                        await walk(path.join(currentPath, entry));
                        if (results.length >= MAX_RESULTS) return;
                    }
                } else if (stats.isFile()) {
                    // Check file size
                    if (stats.size > MAX_FILE_SIZE) return;

                    try {
                        // Attempt to read as text
                        const content = await fs.readFile(contextPath, "utf-8");

                        // Check for binary characters (simple heuristic)
                        if (/\0/.test(content.slice(0, 1000))) return;

                        const lines = content.split("\n");

                        let regex: RegExp;
                        if (type === "regex") {
                            regex = new RegExp(pattern, caseInsensitive ? "i" : "");
                        } else {
                            // Escape regex characters for exact match if we were to use regex, 
                            // but for exact match we can use string includes or regex with escaped pattern
                            // Using regex allows us to easily handle caseInsensitive for exact match too if needed,
                            // or we can just lowerCase both.
                            // Let's use regex with escaped pattern for consistent line-by-line matching
                            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            regex = new RegExp(escaped, caseInsensitive ? "i" : "");
                        }

                        // Collect matching line indices
                        const matches: number[] = [];
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                matches.push(i);
                            }
                        }

                        if (matches.length > 0) {
                            const relativePath = path.relative(process.cwd(), contextPath);

                            // Group overlapping matches
                            let currentGroup: { start: number; end: number } | null = null;
                            const ranges: { start: number; end: number }[] = [];

                            for (const matchIndex of matches) {
                                const start = Math.max(0, matchIndex - padding);
                                const end = Math.min(lines.length - 1, matchIndex + padding);

                                if (!currentGroup) {
                                    currentGroup = { start, end };
                                } else {
                                    if (start <= currentGroup.end + 1) {
                                        // Merge
                                        currentGroup.end = Math.max(currentGroup.end, end);
                                    } else {
                                        // New group
                                        ranges.push(currentGroup);
                                        currentGroup = { start, end };
                                    }
                                }
                            }
                            if (currentGroup) {
                                ranges.push(currentGroup);
                            }

                            for (const range of ranges) {
                                if (results.length >= MAX_RESULTS) break;

                                let snippet = `File: ${relativePath}\n`;
                                for (let i = range.start; i <= range.end; i++) {
                                    // Mark matching line
                                    snippet += `${i + 1}: ${lines[i]}\n`;
                                }
                                results.push(snippet);
                            }
                        }
                    } catch (err) {
                        // Ignore read errors (perms, binary, etc)
                    }
                }
            }

            await walk(searchPath);

            if (results.length === 0) {
                return `No matches found for "${pattern}" in ${searchPath}`;
            }

            return `Found ${results.length} matches:\n${results.join("\n---\n")}`;

        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return `Error searching: ${message}`;
        }
    },
    {
        name: "grep",
        description:
            "Search for a string or regex pattern in the codebase. Returns file paths and line numbers with matching content. useful for finding where a variable or function is used.",
        schema: z.object({
            pattern: z
                .string()
                .describe("The string or regex pattern to search for"),
            path: z
                .string()
                .optional()
                .default(".")
                .describe("The directory or file path to search in. Defaults to current directory (.)."),
            type: z
                .enum(["regex", "exact_match"])
                .optional()
                .default("exact_match")
                .describe("Type of search: 'regex' for regular expressions, 'exact_match' for literal string search."),
            caseInsensitive: z
                .boolean()
                .optional()
                .default(false)
                .describe("Whether to perform a case-insensitive search"),
            padding: z
                .number()
                .optional()
                .default(0)
                .describe("Number of context lines to show above and below each match. Defaults to 0."),
        }),
    }
);
