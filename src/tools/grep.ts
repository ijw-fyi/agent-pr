import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
// @ts-ignore
import safeRegex from "safe-regex2";

/**
 * Tool to search for patterns in the codebase
 */
export const grepTool = tool(
    async ({ pattern, path: searchPath, type, caseInsensitive, padding }) => {
        // Coerce nullable values to defaults
        const effectivePath = searchPath ?? ".";
        const effectiveType = type ?? "exact_match";
        const effectiveCaseInsensitive = caseInsensitive ?? false;
        const effectivePadding = padding ?? 0;

        const results: string[] = [];
        const MAX_RESULTS = 50;
        const MAX_FILE_SIZE = 1024 * 1024; // 1MB

        if (effectiveType === "regex") {
            if (!safeRegex(pattern)) {
                return `Error: The provided regex pattern "${pattern}" is considered unsafe (potential ReDoS). Please use a simpler pattern.`;
            }
        }

        try {
            // Determine the glob pattern
            // If searchPath is a directory, append **/* to search recursively (like grep -r)
            // If it's a glob pattern, use it as is
            let globPattern = effectivePath;
            try {
                // Check if it's an existing directory
                const stats = await fs.stat(effectivePath);
                if (stats.isDirectory()) {
                    globPattern = path.join(effectivePath, "**/*");
                }
            } catch {
                // If fs.stat fails, it's likely a glob pattern or non-existent path
                // We'll treat it as a glob pattern and let glob() handle it
            }

            // Find files using glob
            const files = await glob(globPattern, {
                ignore: ["**/node_modules/**", "**/.git/**", "./build/**", "./dist/**", "./action/**"],
                nodir: true,
                dot: true
            });

            for (const filePath of files) {
                if (results.length >= MAX_RESULTS) break;

                const contextPath = path.resolve(filePath);

                // Security check: Ensure file is within current working directory
                const rootDir = process.cwd();
                const relativeCheck = path.relative(rootDir, contextPath);
                if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
                    continue;
                }

                try {
                    const stats = await fs.stat(contextPath);
                    // Check file size
                    if (stats.size > MAX_FILE_SIZE) continue;

                    // Attempt to read as text
                    const content = await fs.readFile(contextPath, "utf-8");

                    // Check for binary characters (simple heuristic)
                    if (/\0/.test(content.slice(0, 1000))) continue;

                    const lines = content.split("\n");

                    let regex: RegExp;
                    if (effectiveType === "regex") {
                        regex = new RegExp(pattern, effectiveCaseInsensitive ? "i" : "");
                    } else {
                        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        regex = new RegExp(escaped, effectiveCaseInsensitive ? "i" : "");
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
                            const start = Math.max(0, matchIndex - effectivePadding);
                            const end = Math.min(lines.length - 1, matchIndex + effectivePadding);

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
                    // Ignore read errors
                }
            }

            if (results.length === 0) {
                return `No matches found for "${pattern}" in ${effectivePath}`;
            }

            return `Found ${results.length} matches:\n${results.join("\n---\n")}`;

        } catch (error) {
            console.error(`❌ Error in grep:`, error);
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
                .nullable()
                .default(".")
                .describe("The directory or file path to search in. Defaults to current directory (.). Examples: 'src/*.ts', 'src', '**/*.json'"),
            type: z
                .enum(["regex", "exact_match"])
                .optional()
                .nullable()
                .default("exact_match")
                .describe("Type of search: 'regex' for regular expressions, 'exact_match' for literal string search."),
            caseInsensitive: z
                .boolean()
                .optional()
                .nullable()
                .default(false)
                .describe("Whether to perform a case-insensitive search"),
            padding: z
                .number()
                .optional()
                .nullable()
                .default(0)
                .describe("Number of context lines to show above and below each match. Defaults to 0."),
        }),
    }
);
