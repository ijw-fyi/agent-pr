import * as TreeSitter from "web-tree-sitter";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Language to WASM file mapping
const LANGUAGE_WASM_MAP: Record<string, string> = {
    typescript: "tree-sitter-typescript.wasm",
    tsx: "tree-sitter-tsx.wasm",
    javascript: "tree-sitter-javascript.wasm",
    python: "tree-sitter-python.wasm",
    c: "tree-sitter-c.wasm",
    cpp: "tree-sitter-cpp.wasm",
};

// File extension to language mapping
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyw": "python",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".hh": "cpp",
};

// Singleton parser instance
let parserInitialized = false;
const languageCache = new Map<TreeSitter.Language, TreeSitter.Language>();

// Type alias for syntax nodes
type SyntaxNode = ReturnType<TreeSitter.Tree["rootNode"]["child"]> & { type: string; text: string; children: SyntaxNode[]; startPosition: { row: number; column: number }; endPosition: { row: number; column: number }; startIndex: number; childForFieldName: (name: string) => SyntaxNode | null };

/**
 * Symbol extracted from source code
 */
export interface CodeSymbol {
    name: string;
    kind: "function" | "class" | "method" | "interface" | "type" | "variable";
    startLine: number;
    endLine: number;
    signature?: string;
}

/**
 * Initialize the tree-sitter parser (must be called before parsing)
 */
export async function initParser(): Promise<void> {
    if (parserInitialized) return;

    // Provide locateFile to help find web-tree-sitter.wasm in bundled environments
    await TreeSitter.Parser.init({
        locateFile(scriptName: string) {
            // Check bundled location (action/node_modules/web-tree-sitter/)
            // __dirname is the action/ directory where index.js lives
            const bundledPath = join(__dirname, "node_modules", "web-tree-sitter", scriptName);
            if (existsSync(bundledPath)) return bundledPath;

            // Development: node_modules from CWD
            const devPath = join(process.cwd(), "node_modules", "web-tree-sitter", scriptName);
            if (existsSync(devPath)) return devPath;

            return scriptName;
        }
    });
    parserInitialized = true;
}

/**
 * Get the language name from a file extension
 */
export function getLanguageFromExtension(ext: string): string | undefined {
    return EXTENSION_LANGUAGE_MAP[ext.toLowerCase()];
}

/**
 * Check if a file extension is supported
 */
export function isExtensionSupported(ext: string): boolean {
    return ext.toLowerCase() in EXTENSION_LANGUAGE_MAP;
}

/**
 * Get list of supported extensions
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(EXTENSION_LANGUAGE_MAP);
}

/**
 * Load a language grammar
 */
async function loadLanguage(langName: string): Promise<TreeSitter.Language> {
    // Check cache first (using langName as key, storing in a separate map)
    const cached = langNameCache.get(langName);
    if (cached) return cached;

    const wasmFile = LANGUAGE_WASM_MAP[langName];
    if (!wasmFile) {
        throw new Error(`Unsupported language: ${langName}`);
    }

    // Try multiple paths for WASM files (handles both dev and bundled scenarios)
    const possiblePaths = [
        join(__dirname, "wasm", wasmFile),           // Dev: src/helpers/wasm/
        join(__dirname, "..", "helpers", "wasm", wasmFile), // Bundled: action/helpers/wasm/
        join(process.cwd(), "src", "helpers", "wasm", wasmFile), // CWD fallback
        join(process.cwd(), "action", "wasm", wasmFile),     // Action bundle fallback
    ];

    let language: TreeSitter.Language | null = null;
    for (const wasmPath of possiblePaths) {
        try {
            language = await TreeSitter.Language.load(wasmPath);
            break;
        } catch {
            // Try next path
        }
    }

    if (!language) {
        throw new Error(`Failed to load WASM for language: ${langName}. Tried paths: ${possiblePaths.join(", ")}`);
    }

    langNameCache.set(langName, language);
    return language;
}

// Cache by language name string
const langNameCache = new Map<string, TreeSitter.Language>();

/**
 * Parse source code and extract symbols (functions, classes, methods, etc.)
 */
export async function extractSymbols(
    sourceCode: string,
    language: string
): Promise<CodeSymbol[]> {
    await initParser();

    const lang = await loadLanguage(language);
    const parser = new TreeSitter.Parser();
    parser.setLanguage(lang);

    const tree = parser.parse(sourceCode);
    if (!tree) {
        return [];
    }

    const symbols: CodeSymbol[] = [];

    try {
        // Use language-specific extraction
        switch (language) {
            case "typescript":
            case "tsx":
                extractTypeScriptSymbols(tree.rootNode as unknown as SyntaxNode, sourceCode, symbols);
                break;
            case "javascript":
                extractJavaScriptSymbols(tree.rootNode as unknown as SyntaxNode, sourceCode, symbols);
                break;
            case "python":
                extractPythonSymbols(tree.rootNode as unknown as SyntaxNode, sourceCode, symbols);
                break;
            case "c":
                extractCSymbols(tree.rootNode as unknown as SyntaxNode, sourceCode, symbols);
                break;
            case "cpp":
                extractCppSymbols(tree.rootNode as unknown as SyntaxNode, sourceCode, symbols);
                break;
        }
    } finally {
        // Clean up WASM memory
        tree.delete();
        parser.delete();
    }

    // Sort by start line
    return symbols.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Result of extracting a code item
 */
export interface CodeItemResult {
    found: boolean;
    name: string;
    kind?: string;
    startLine?: number;
    endLine?: number;
    code?: string;
    error?: string;
}

/**
 * Extract a specific code item (function, class, method) by name
 * Returns the source code for that item with line numbers
 */
export async function extractCodeItem(
    sourceCode: string,
    language: string,
    symbolName: string
): Promise<CodeItemResult> {
    // First extract all symbols
    const symbols = await extractSymbols(sourceCode, language);

    // Find the symbol (support both exact match and partial match for methods)
    let symbol = symbols.find(s => s.name === symbolName);

    // If not found, try matching just the method/function name (for Class.method notation)
    if (!symbol && symbolName.includes('.')) {
        symbol = symbols.find(s => s.name === symbolName);
    }

    // Also try finding by just the last part (e.g., "getUser" matches "UserService.getUser")
    if (!symbol) {
        symbol = symbols.find(s => s.name.endsWith(`.${symbolName}`) || s.name.endsWith(`::${symbolName}`));
    }

    // Also try finding where the symbol name ends with our query
    if (!symbol) {
        symbol = symbols.find(s => s.name === symbolName || s.name.split('.').pop() === symbolName || s.name.split('::').pop() === symbolName);
    }

    if (!symbol) {
        // Return available symbols as hint
        const available = symbols.map(s => s.name).slice(0, 10);
        return {
            found: false,
            name: symbolName,
            error: `Symbol "${symbolName}" not found. Available: ${available.join(', ')}${symbols.length > 10 ? '...' : ''}`
        };
    }

    // Extract the code for this symbol
    const lines = sourceCode.split('\n');
    const codeLines: string[] = [];

    for (let i = symbol.startLine - 1; i < symbol.endLine && i < lines.length; i++) {
        codeLines.push(`${i + 1}: ${lines[i]}`);
    }

    return {
        found: true,
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        code: codeLines.join('\n')
    };
}

/**
 * Reference found in source code
 */
export interface CodeReference {
    line: number;
    column: number;
    context: string;
    nodeType: string;
}

/**
 * Find all references to an identifier in source code
 * Uses tree-sitter to find actual identifier nodes (excludes comments, strings)
 */
export async function findIdentifierReferences(
    sourceCode: string,
    language: string,
    identifierName: string
): Promise<CodeReference[]> {
    await initParser();

    const lang = await loadLanguage(language);
    const parser = new TreeSitter.Parser();
    parser.setLanguage(lang);

    const tree = parser.parse(sourceCode);
    if (!tree) {
        return [];
    }

    const references: CodeReference[] = [];
    const lines = sourceCode.split('\n');

    try {
        // Walk the tree and find matching identifiers
        const visit = (node: SyntaxNode) => {
            // Check if this is an identifier-like node with matching text
            const identifierTypes = [
                'identifier',
                'property_identifier',
                'field_identifier',
                'type_identifier',
                'shorthand_property_identifier',
            ];

            if (identifierTypes.includes(node.type) && node.text === identifierName) {
                const line = node.startPosition.row + 1;
                references.push({
                    line,
                    column: node.startPosition.column + 1,
                    context: lines[node.startPosition.row]?.trim() || '',
                    nodeType: node.type,
                });
            }

            // Visit children
            for (const child of node.children) {
                visit(child as SyntaxNode);
            }
        };

        visit(tree.rootNode as unknown as SyntaxNode);
    } finally {
        tree.delete();
        parser.delete();
    }

    // Sort by line number and deduplicate
    return references
        .sort((a, b) => a.line - b.line || a.column - b.column)
        .filter((ref, i, arr) =>
            i === 0 || ref.line !== arr[i - 1].line || ref.column !== arr[i - 1].column
        );
}

/**
 * Helper to get signature (first line of the node, cleaned up)
 */
function getSignature(node: SyntaxNode, sourceCode: string, maxLength: number = 100): string {
    const startIndex = node.startIndex;
    const lines = sourceCode.slice(startIndex).split("\n");
    let sig = lines[0].trim();

    // For multi-line signatures, try to get up to the opening brace or colon
    if (!sig.includes("{") && !sig.includes(":") && lines.length > 1) {
        for (let i = 1; i < Math.min(lines.length, 5); i++) {
            sig += " " + lines[i].trim();
            if (sig.includes("{") || sig.includes(":")) break;
        }
    }

    // Truncate at opening brace for cleaner signature
    const braceIndex = sig.indexOf("{");
    if (braceIndex > 0) {
        sig = sig.slice(0, braceIndex).trim();
    }

    if (sig.length > maxLength) {
        sig = sig.slice(0, maxLength - 3) + "...";
    }

    return sig;
}

/**
 * Extract symbols from TypeScript source
 */
function extractTypeScriptSymbols(
    root: SyntaxNode,
    sourceCode: string,
    symbols: CodeSymbol[]
): void {
    const visit = (node: SyntaxNode, parentClass?: string) => {
        switch (node.type) {
            case "function_declaration":
            case "function": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    symbols.push({
                        name: nameNode.text,
                        kind: "function",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
            case "class_declaration": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    const className = nameNode.text;
                    symbols.push({
                        name: className,
                        kind: "class",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                    // Visit children with class context
                    for (const child of node.children) {
                        visit(child as SyntaxNode, className);
                    }
                    return; // Don't double-visit children
                }
                break;
            }
            case "method_definition": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    const methodName = parentClass
                        ? `${parentClass}.${nameNode.text}`
                        : nameNode.text;
                    symbols.push({
                        name: methodName,
                        kind: "method",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
            case "interface_declaration": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    symbols.push({
                        name: nameNode.text,
                        kind: "interface",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
            case "type_alias_declaration": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    symbols.push({
                        name: nameNode.text,
                        kind: "type",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
            case "lexical_declaration":
            case "variable_declaration": {
                // Check for arrow functions assigned to variables
                for (const child of node.children) {
                    if ((child as SyntaxNode).type === "variable_declarator") {
                        const varDecl = child as SyntaxNode;
                        const nameNode = varDecl.childForFieldName("name");
                        const valueNode = varDecl.childForFieldName("value");
                        if (nameNode && valueNode?.type === "arrow_function") {
                            symbols.push({
                                name: nameNode.text,
                                kind: "function",
                                startLine: node.startPosition.row + 1,
                                endLine: node.endPosition.row + 1,
                                signature: getSignature(node, sourceCode),
                            });
                        }
                    }
                }
                break;
            }
            case "export_statement": {
                // Handle exported declarations
                for (const child of node.children) {
                    visit(child as SyntaxNode, parentClass);
                }
                return;
            }
        }

        // Visit children
        for (const child of node.children) {
            visit(child as SyntaxNode, parentClass);
        }
    };

    visit(root);
}

/**
 * Extract symbols from JavaScript source (similar to TypeScript but fewer types)
 */
function extractJavaScriptSymbols(
    root: SyntaxNode,
    sourceCode: string,
    symbols: CodeSymbol[]
): void {
    // JavaScript extraction is similar to TypeScript, reuse with minor adjustments
    extractTypeScriptSymbols(root, sourceCode, symbols);
}

/**
 * Extract symbols from Python source
 */
function extractPythonSymbols(
    root: SyntaxNode,
    sourceCode: string,
    symbols: CodeSymbol[]
): void {
    const visit = (node: SyntaxNode, parentClass?: string) => {
        switch (node.type) {
            case "function_definition": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    const isMethod = !!parentClass;
                    const funcName = isMethod
                        ? `${parentClass}.${nameNode.text}`
                        : nameNode.text;
                    symbols.push({
                        name: funcName,
                        kind: isMethod ? "method" : "function",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
            case "class_definition": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    const className = nameNode.text;
                    symbols.push({
                        name: className,
                        kind: "class",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                    // Visit children with class context
                    for (const child of node.children) {
                        visit(child as SyntaxNode, className);
                    }
                    return;
                }
                break;
            }
        }

        // Visit children
        for (const child of node.children) {
            visit(child as SyntaxNode, parentClass);
        }
    };

    visit(root);
}

/**
 * Extract symbols from C source
 */
function extractCSymbols(
    root: SyntaxNode,
    sourceCode: string,
    symbols: CodeSymbol[]
): void {
    const visit = (node: SyntaxNode) => {
        switch (node.type) {
            case "function_definition": {
                const declarator = node.childForFieldName("declarator");
                if (declarator) {
                    // Navigate to the function name
                    let nameNode: SyntaxNode | null = declarator;
                    while (nameNode && nameNode.type !== "identifier") {
                        nameNode = nameNode.childForFieldName("declarator") || (nameNode.children[0] as SyntaxNode | null);
                    }
                    if (nameNode?.type === "identifier") {
                        symbols.push({
                            name: nameNode.text,
                            kind: "function",
                            startLine: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            signature: getSignature(node, sourceCode),
                        });
                    }
                }
                break;
            }
            case "struct_specifier":
            case "enum_specifier": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    symbols.push({
                        name: nameNode.text,
                        kind: "type",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                }
                break;
            }
        }

        // Visit children
        for (const child of node.children) {
            visit(child as SyntaxNode);
        }
    };

    visit(root);
}

/**
 * Extract symbols from C++ source
 */
function extractCppSymbols(
    root: SyntaxNode,
    sourceCode: string,
    symbols: CodeSymbol[]
): void {
    const visit = (node: SyntaxNode, parentClass?: string) => {
        switch (node.type) {
            case "function_definition": {
                const declarator = node.childForFieldName("declarator");
                if (declarator) {
                    // Navigate to the function name (handle nested declarators)
                    let nameNode: SyntaxNode | null = declarator;
                    while (nameNode && !["identifier", "field_identifier", "destructor_name"].includes(nameNode.type)) {
                        nameNode = nameNode.childForFieldName("declarator") ||
                            (nameNode.children.find((c: SyntaxNode) => c.type === "identifier" || c.type === "field_identifier") as SyntaxNode | undefined) ||
                            (nameNode.children[0] as SyntaxNode | null);
                    }
                    if (nameNode && ["identifier", "field_identifier", "destructor_name"].includes(nameNode.type)) {
                        const funcName = parentClass
                            ? `${parentClass}::${nameNode.text}`
                            : nameNode.text;
                        symbols.push({
                            name: funcName,
                            kind: parentClass ? "method" : "function",
                            startLine: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            signature: getSignature(node, sourceCode),
                        });
                    }
                }
                break;
            }
            case "class_specifier":
            case "struct_specifier": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    const className = nameNode.text;
                    symbols.push({
                        name: className,
                        kind: "class",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: getSignature(node, sourceCode),
                    });
                    // Visit body with class context
                    const body = node.childForFieldName("body");
                    if (body) {
                        for (const child of body.children) {
                            visit(child as SyntaxNode, className);
                        }
                    }
                    return;
                }
                break;
            }
            case "namespace_definition": {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    symbols.push({
                        name: nameNode.text,
                        kind: "type",
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        signature: `namespace ${nameNode.text}`,
                    });
                }
                break;
            }
        }

        // Visit children
        for (const child of node.children) {
            visit(child as SyntaxNode, parentClass);
        }
    };

    visit(root);
}
