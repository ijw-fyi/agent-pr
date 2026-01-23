import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileContent, getOctokit } from "../context/github.js";

/**
 * Tool to read file contents from the repository
 */
export const readFileTool = tool(
    async ({ path, startLine, endLine }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const ref = process.env.HEAD_SHA!;

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
                return `File: ${path} (lines ${startLine || 1}-${endLine || "end"})\n\n${content}`;
            }
            return `File: ${path}\n\n${content}`;
        } catch (error) {
            console.error(`❌ Error in read_file:`, error);
            return `Error reading file ${path}: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "read_file",
        description:
            "Read the contents of a file from the repository. Use this to get more context about the code being reviewed.",
        schema: z.object({
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
        }),
    }
);
