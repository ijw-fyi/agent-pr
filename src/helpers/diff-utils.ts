/**
 * Shared diff parsing, filtering, and truncation utilities.
 *
 * Used by both the review agents (to build context messages) and the
 * tools layer (e.g., get_file_diff), so this lives in helpers/ to keep
 * dependency arrows pointing downward.
 */

import { minimatch } from "minimatch";

// Files that should be excluded from diff context and LOC counting
const LOCK_FILES = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'bun.lockb'];
const BINARY_EXTENSIONS = ['.wasm', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz'];
const ARTIFACT_EXTENSIONS = ['.min.js', '.map', '.svg', '.json'];

/**
 * Check if a file should be excluded from review based on its path
 */
export function shouldExcludeFile(fileName: string): boolean {
    const baseName = fileName.split('/').pop() || fileName;
    const lowerFileName = fileName.toLowerCase();

    // Check for lock files
    if (LOCK_FILES.includes(baseName)) return true;

    // Check for binary files
    if (BINARY_EXTENSIONS.some(ext => lowerFileName.endsWith(ext))) return true;

    // Check for artifact files
    if (ARTIFACT_EXTENSIONS.some(ext => lowerFileName.endsWith(ext))) return true;

    // Check for build directories
    if (/\/dist\/|\/build\/|\/out\/|\/node_modules\//.test(fileName)) return true;

    return false;
}

/**
 * Get ignore glob patterns from the PR_AGENT_IGNORE env var
 */
function getIgnorePatterns(): string[] {
    const raw = process.env.PR_AGENT_IGNORE;
    if (!raw) return [];
    return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * Check if a file should be ignored based on --ignore glob patterns
 */
function shouldIgnoreFile(fileName: string): boolean {
    const patterns = getIgnorePatterns();
    if (patterns.length === 0) return false;
    return patterns.some(pattern => minimatch(fileName, pattern, { matchBase: true }));
}

/**
 * Count changed lines in a single file diff section
 */
function countFileDiffLines(fileDiff: string): number {
    let count = 0;
    for (const line of fileDiff.split('\n')) {
        if ((line.startsWith('+') && !line.startsWith('+++')) ||
            (line.startsWith('-') && !line.startsWith('---'))) {
            count++;
        }
    }
    return count;
}

/**
 * Filter out excluded files from a diff string
 */
function filterExcludedFiles(diff: string): string {
    const parts = diff.split(/(?=^diff --git )/m);

    return parts.filter(part => {
        if (!part.trim()) return true;

        const headerLine = part.split('\n')[0];
        const match = headerLine.match(/diff --git a\/(.*?) b\//);

        if (match) {
            return !shouldExcludeFile(match[1]) && !shouldIgnoreFile(match[1]);
        }

        return true;
    }).join('');
}

/**
 * Count the number of lines of code changed in a diff
 * Counts lines starting with + or - (excluding diff headers like +++ and ---)
 * Excludes lock files, binaries, and other non-reviewable files
 */
export function countDiffLOC(diff: string): number {
    const filteredDiff = filterExcludedFiles(diff);
    const lines = filteredDiff.split('\n');
    let loc = 0;
    for (const line of lines) {
        // Count lines that start with + or - but not +++ or ---
        if ((line.startsWith('+') && !line.startsWith('+++')) ||
            (line.startsWith('-') && !line.startsWith('---'))) {
            loc++;
        }
    }
    return loc;
}

/**
 * Extract changed file paths from a diff string, excluding lock/binary/artifact files
 */
export function extractChangedFiles(diff: string): string[] {
    const files: string[] = [];
    const parts = diff.split(/(?=^diff --git )/m);

    for (const part of parts) {
        if (!part.trim()) continue;
        const headerLine = part.split('\n')[0];
        const match = headerLine.match(/diff --git a\/(.*?) b\//);
        if (match && !shouldExcludeFile(match[1])) {
            files.push(match[1]);
        }
    }

    return files;
}

/**
 * Truncate a single diff part (one file's diff section).
 * Handles exclusions, binary files, and size limits.
 */
export function truncateDiffPart(part: string): string {
    const MAX_LINES_PER_FILE = 500;
    const MAX_CHARS_PER_FILE = 40000; // avg 80 characters per line

    if (!part.trim()) return part;

    // Check for binary files or excluded extensions
    // Format: diff --git a/path/to/file.ext b/path/to/file.ext
    const headerLine = part.split('\n')[0];
    const match = headerLine.match(/diff --git a\/(.*?) b\//);

    if (match) {
        const fileName = match[1];

        // Use shared exclusion logic
        if (shouldExcludeFile(fileName)) {
            return `${headerLine}\n... (File excluded from diff context)\n`;
        }

        // Check user-specified ignore patterns
        if (shouldIgnoreFile(fileName)) {
            const linesChanged = countFileDiffLines(part);
            const sizeKB = (Buffer.byteLength(part, 'utf8') / 1024).toFixed(1);
            return `${headerLine}\n... (File requested to be ignored by the user: ${linesChanged} lines changed, ${sizeKB} KB)\n`;
        }

        // Special handling for large JS/TS files that might be bundles
        // If it's a JS file and huge, it's likely a bundle we missed
        if (/\.(js|mjs|cjs|ts|tsx)$/.test(fileName) && part.length > MAX_CHARS_PER_FILE) {
            return `${headerLine}\n... (Large file excluded from diff context - likely generated or too big to review inline)\n`;
        }
    }

    // Also check if the diff itself says "Binary files ... differ"
    if (part.includes("Binary files") && part.includes("differ")) {
        return part.split('\n').filter(l => l.startsWith('diff --git') || l.includes('Binary files')).join('\n') + '\n';
    }

    if (part.length > MAX_CHARS_PER_FILE) {
        return part.slice(0, MAX_CHARS_PER_FILE) + "\n... (File diff truncated: exceeds 10k chars)\n";
    }

    const lines = part.split('\n');
    if (lines.length > MAX_LINES_PER_FILE) {
        return lines.slice(0, MAX_LINES_PER_FILE).join('\n') + "\n... (File diff truncated: exceeds 500 lines)\n";
    }

    return part;
}

/**
 * Truncate each file section in a diff independently
 */
export function truncateDiff(diff: string): string {
    const parts = diff.split(/(?=^diff --git )/m);
    return parts.map(truncateDiffPart).join('');
}
