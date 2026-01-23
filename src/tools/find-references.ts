import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import {
    findIdentifierReferences,
    getLanguageFromExtension,
    isExtensionSupported,
    getSupportedExtensions,
    type CodeReference,
} from "../helpers/tree-sitter.js";

const MAX_FILES = 30;
const MAX_FILE_SIZE = 512 * 1024; // 512KB
const MAX_RESULTS = 50;

/**
 * Tool to find references to a symbol across the codebase
 * Uses grep-like text search to pre-filter files, then tree-sitter for accuracy
 */
export const findReferencesTool = tool(
    async ({ symbol, directory }) => {
        const searchDir = directory || ".";

        try {
            // Step 1: Find candidate files using text search (fast)
            const supportedExtensions = getSupportedExtensions();
            const globPatterns = supportedExtensions.map(ext =>
                path.join(searchDir, "**", `*${ext}`)
            );

            const allFiles: string[] = [];
            for (const pattern of globPatterns) {
                const files = await glob(pattern, {
                    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/action/**"],
                    nodir: true,
                });
                allFiles.push(...files);
            }

            // Step 2: Pre-filter files that contain the symbol text
            const candidateFiles: string[] = [];
            for (const filePath of allFiles) {
                if (candidateFiles.length >= MAX_FILES) break;

                try {
                    const stats = await fs.stat(filePath);
                    if (stats.size > MAX_FILE_SIZE) continue;

                    const content = await fs.readFile(filePath, "utf-8");
                    // Quick text check before expensive parsing
                    if (content.includes(symbol)) {
                        candidateFiles.push(filePath);
                    }
                } catch {
                    // Skip unreadable files
                }
            }

            if (candidateFiles.length === 0) {
                return `No files containing "${symbol}" found in ${searchDir}`;
            }

            // Step 3: Parse each candidate file with tree-sitter for accurate references
            const allRefs: { file: string; refs: CodeReference[] }[] = [];
            let totalRefs = 0;

            for (const filePath of candidateFiles) {
                if (totalRefs >= MAX_RESULTS) break;

                const ext = path.extname(filePath);
                const language = getLanguageFromExtension(ext);
                if (!language) continue;

                try {
                    const content = await fs.readFile(filePath, "utf-8");
                    const refs = await findIdentifierReferences(content, language, symbol);

                    if (refs.length > 0) {
                        const remaining = MAX_RESULTS - totalRefs;
                        const limitedRefs = refs.slice(0, remaining);
                        allRefs.push({ file: filePath, refs: limitedRefs });
                        totalRefs += limitedRefs.length;
                    }
                } catch {
                    // Skip files that fail to parse
                }
            }

            if (allRefs.length === 0) {
                return `No code references to "${symbol}" found (may exist in comments/strings only)`;
            }

            // Format output compactly
            const lines: string[] = [`References to "${symbol}" (${totalRefs} found)`];

            for (const { file, refs } of allRefs) {
                const relPath = path.relative(process.cwd(), file);
                for (const ref of refs) {
                    lines.push(`${relPath}:${ref.line}: ${ref.context}`);
                }
            }

            if (totalRefs >= MAX_RESULTS) {
                lines.push(`... (limited to ${MAX_RESULTS} results)`);
            }

            return lines.join("\n");

        } catch (error) {
            console.error(`❌ Error in find_references:`, error);
            return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
    {
        name: "find_references",
        description: `Find all references to a symbol (function, variable, class) across the codebase. More accurate than grep - uses syntax parsing to exclude comments and strings. Supports: ${getSupportedExtensions().join(", ")}`,
        schema: z.object({
            symbol: z
                .string()
                .describe("The symbol name to find references for (e.g., 'getUserById', 'UserService')"),
            directory: z
                .string()
                .optional()
                .nullable()
                .describe("Directory to search in. Defaults to current directory."),
        }),
    }
);
