import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileContent } from "../context/github.js";
import {
    extractSymbols,
    getLanguageFromExtension,
    isExtensionSupported,
    getSupportedExtensions,
    type CodeSymbol,
} from "../helpers/tree-sitter.js";
import { extname } from "path";

/**
 * Format symbols into a compact, token-efficient outline
 */
function formatOutline(path: string, symbols: CodeSymbol[]): string {
    if (symbols.length === 0) {
        return `${path}: no symbols found`;
    }

    const lines: string[] = [`${path} (${symbols.length} symbols)`];

    for (const symbol of symbols) {
        const lineRange = symbol.startLine === symbol.endLine
            ? `L${symbol.startLine}`
            : `L${symbol.startLine}-${symbol.endLine}`;

        const kind = {
            function: "fn",
            class: "class",
            method: "method",
            interface: "iface",
            type: "type",
            variable: "var",
        }[symbol.kind] || symbol.kind;

        lines.push(`[${kind}:${lineRange}] ${symbol.name}`);
    }

    return lines.join("\n");
}

/**
 * Tool to get the outline (functions, classes, methods) of a file
 */
export const fileOutlineTool = tool(
    async ({ path }) => {
        const owner = process.env.REPO_OWNER!;
        const repo = process.env.REPO_NAME!;
        const ref = process.env.HEAD_SHA!;

        // Check if file extension is supported
        const ext = extname(path);
        if (!isExtensionSupported(ext)) {
            const supported = getSupportedExtensions().join(", ");
            return `File extension "${ext}" is not supported for outline extraction. Supported extensions: ${supported}. Use read_file instead.`;
        }

        try {
            // Fetch file content from GitHub
            const content = await readFileContent(owner, repo, path, ref);

            // Get language from extension
            const language = getLanguageFromExtension(ext);
            if (!language) {
                return `Could not determine language for extension "${ext}".`;
            }

            // Extract symbols
            const symbols = await extractSymbols(content, language);

            return formatOutline(path, symbols);
        } catch (error) {
            return `Error getting outline for ${path}: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "get_file_outline",
        description: `Get the structural outline of a source file - lists all functions, classes, methods, and their line ranges WITHOUT reading the full file content. Use this to understand file structure before deciding which parts to read in detail. Much more efficient than read_file for understanding what's in a file. Supported: ${getSupportedExtensions().join(", ")}`,
        schema: z.object({
            path: z
                .string()
                .describe("File path relative to repository root (e.g., 'src/utils/helpers.ts')"),
        }),
    }
);
