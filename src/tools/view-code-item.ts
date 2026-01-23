import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileContent } from "../context/github.js";
import {
    extractCodeItem,
    getLanguageFromExtension,
    isExtensionSupported,
    getSupportedExtensions,
} from "../helpers/tree-sitter.js";
import { extname } from "path";

/**
 * Tool to view a specific code item (function, class, method) by name
 */
export const viewCodeItemTool = tool(
    async ({ path, symbol }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const ref = process.env.HEAD_SHA!;

        // Check if file extension is supported
        const ext = extname(path);
        if (!isExtensionSupported(ext)) {
            const supported = getSupportedExtensions().join(", ");
            return `Extension "${ext}" not supported. Supported: ${supported}. Use read_file instead.`;
        }

        try {
            // Fetch file content from GitHub
            const content = await readFileContent(owner, repo, path, ref);

            // Get language from extension
            const language = getLanguageFromExtension(ext);
            if (!language) {
                return `Could not determine language for "${ext}".`;
            }

            // Extract the specific code item
            const result = await extractCodeItem(content, language, symbol);

            if (!result.found) {
                return result.error || `Symbol "${symbol}" not found in ${path}`;
            }

            return `[${result.kind}:L${result.startLine}-${result.endLine}] ${result.name}\n${result.code}`;
        } catch (error) {
            console.error(`❌ Error in view_code_item:`, error);
            return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "view_code_item",
        description: `View a specific function, class, or method by name. More precise than read_file - extracts just the requested symbol's code. Use get_file_outline first to see available symbols. Supports: ${getSupportedExtensions().join(", ")}`,
        schema: z.object({
            path: z
                .string()
                .describe("File path relative to repository root"),
            symbol: z
                .string()
                .describe("Symbol name to view (e.g., 'runReview', 'UserService.getUser', 'UserService')"),
        }),
    }
);
