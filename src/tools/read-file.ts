import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileContent } from "../context/github.js";

/**
 * Tool to read multiple file contents from the repository in a single call
 */
export const readFilesTool = tool(
    async ({ files }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const ref = process.env.HEAD_SHA!;

        const results: string[] = [];

        for (const file of files) {
            const { path, startLine, endLine } = file;
            try {
                const content = await readFileContent(
                    owner,
                    repo,
                    path,
                    ref,
                    startLine ?? undefined,
                    endLine ?? undefined
                );

                if (startLine || endLine) {
                    results.push(`=== File: ${path} (lines ${startLine || 1}-${endLine || "end"}) ===\n${content}`);
                } else {
                    results.push(`=== File: ${path} ===\n${content}`);
                }
            } catch (error) {
                console.error(`❌ Error reading ${path}:`, error);
                results.push(`=== File: ${path} ===\nError: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }

        return results.join("\n\n");
    },
    {
        name: "read_files",
        description:
            "Read the contents of one or more files from the repository in a single call. Batch multiple file reads together to reduce round trips.",
        schema: z.object({
            files: z
                .array(
                    z.object({
                        path: z
                            .string()
                            .describe("File path relative to repository root (e.g., 'src/index.ts')"),
                        startLine: z
                            .number()
                            .optional()
                            .nullable()
                            .describe("Start line number (1-indexed). Omit to read from beginning."),
                        endLine: z
                            .number()
                            .optional()
                            .nullable()
                            .describe("End line number (1-indexed, inclusive). Omit to read to end."),
                    })
                )
                .describe("Array of files to read. Include all files you need in a single call."),
        }),
    }
);
