import * as github from "@actions/github";
import type {
    PRContext,
    ReviewComment,
    ConversationComment,
} from "./types.js";
import { readPreferences } from "../preferences/index.js";

type Octokit = ReturnType<typeof github.getOctokit>;

let octokit: Octokit;

/**
 * Initialize the GitHub client
 */
export function initGitHub(token: string): void {
    octokit = github.getOctokit(token);
}

/**
 * Get the Octokit instance (for use in tools)
 */
export function getOctokit(): Octokit {
    if (!octokit) {
        throw new Error("GitHub client not initialized. Call initGitHub first.");
    }
    return octokit;
}

/**
 * Gather all context needed for PR review
 */
export async function gatherPRContext(
    owner: string,
    repo: string,
    prNumber: number
): Promise<PRContext> {
    const [pr, diff, reviewComments, issueComments, preferences] = await Promise.all([
        getPullRequest(owner, repo, prNumber),
        getPRDiff(owner, repo, prNumber),
        getReviewComments(owner, repo, prNumber),
        getConversation(owner, repo, prNumber),
        readPreferences(owner, repo),
    ]);

    return {
        owner,
        repo,
        prNumber,
        title: pr.title,
        description: pr.body,
        author: pr.user?.login || "unknown",
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        diff,
        existingComments: reviewComments,
        conversation: issueComments,
        preferences,
    };
}

/**
 * Get PR details
 */
async function getPullRequest(owner: string, repo: string, prNumber: number) {
    const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
    });
    return data;
}

/**
 * Get the unified diff for a PR
 */
async function getPRDiff(
    owner: string,
    repo: string,
    prNumber: number
): Promise<string> {
    const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
            format: "diff",
        },
    });
    // When requesting diff format, data is returned as a string
    return data as unknown as string;
}

/**
 * Extract changed file paths from a unified diff
 */
function extractChangedFilesFromDiff(diff: string): string[] {
    const files: string[] = [];
    const lines = diff.split('\n');

    for (const line of lines) {
        // Match diff headers like "diff --git a/path/to/file b/path/to/file"
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (match) {
            // Use the "b" path (destination) as it represents the current state
            files.push(match[2]);
        }
    }

    return files;
}

/**
 * Get a focused project file tree at a specific ref
 * Only shows directories containing files from the diff + sibling context
 */
async function getProjectTree(
    owner: string,
    repo: string,
    ref: string,
    changedFiles?: string[]
): Promise<string> {
    try {
        const { data } = await octokit.rest.git.getTree({
            owner,
            repo,
            tree_sha: ref,
            recursive: "true",
        });

        const allFiles = data.tree
            .filter((item) => item.type === "blob")
            .map((item) => item.path!)
            .sort();

        // If no changed files, show limited tree (top-level + src/)
        if (!changedFiles || changedFiles.length === 0) {
            return formatTreeStructure(allFiles.slice(0, 100));
        }

        // Build set of relevant directories from changed files
        const relevantDirs = new Set<string>();
        for (const file of changedFiles) {
            const parts = file.split('/');
            // Add all parent directories
            for (let i = 1; i <= parts.length; i++) {
                relevantDirs.add(parts.slice(0, i).join('/'));
            }
        }

        // Filter to files in relevant directories
        const relevantFiles = allFiles.filter(file => {
            const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';
            return relevantDirs.has(dir) || relevantDirs.has(file) || !file.includes('/');
        });

        // Limit to reasonable size
        const maxFiles = 200;
        const limitedFiles = relevantFiles.slice(0, maxFiles);

        if (relevantFiles.length > maxFiles) {
            return formatTreeStructure(limitedFiles) + `\n... and ${relevantFiles.length - maxFiles} more files`;
        }

        return formatTreeStructure(limitedFiles);
    } catch (error) {
        console.error("Error fetching project tree:", error);
        return "(Unable to fetch project tree)";
    }
}

/**
 * Format files as a tree structure (more compact than flat list)
 */
function formatTreeStructure(files: string[]): string {
    const tree: Record<string, any> = {};

    // Build tree structure
    for (const file of files) {
        const parts = file.split('/');
        let current = tree;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                // File
                current[part] = null;
            } else {
                // Directory
                if (!current[part]) current[part] = {};
                current = current[part];
            }
        }
    }

    // Render tree as string
    function renderNode(node: Record<string, any>, prefix: string = ''): string[] {
        const lines: string[] = [];
        const entries = Object.entries(node).sort(([a], [b]) => {
            // Directories first
            const aIsDir = node[a] !== null;
            const bIsDir = node[b] !== null;
            if (aIsDir !== bIsDir) return bIsDir ? 1 : -1;
            return a.localeCompare(b);
        });

        for (let i = 0; i < entries.length; i++) {
            const [name, child] = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');

            if (child === null) {
                lines.push(prefix + connector + name);
            } else {
                lines.push(prefix + connector + name + '/');
                lines.push(...renderNode(child, childPrefix));
            }
        }
        return lines;
    }

    return renderNode(tree).join('\n');
}

/**
 * Get existing review comments on the PR
 */
async function getReviewComments(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ReviewComment[]> {
    const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
    });

    return data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login || "unknown",
        body: comment.body,
        path: comment.path,
        line: comment.line || null,
        createdAt: comment.created_at,
    }));
}

/**
 * Get conversation comments on the PR (issue comments)
 */
async function getConversation(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ConversationComment[]> {
    const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
    });

    return data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login || "unknown",
        body: comment.body || "",
        createdAt: comment.created_at,
    }));
}

/**
 * Read a file from the repository at a specific ref
 */
export async function readFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    startLine?: number,
    endLine?: number
): Promise<string> {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
        });

        if ("content" in data && data.type === "file") {
            const content = Buffer.from(data.content, "base64").toString("utf-8");

            // Apply line filtering if specified
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split("\n");
                const start = (startLine || 1) - 1; // Convert to 0-indexed
                const end = endLine || lines.length;
                return lines.slice(start, end).join("\n");
            }

            return content;
        }

        return "(Path is a directory, not a file)";
    } catch (error) {
        if (error instanceof Error && error.message.includes("Not Found")) {
            return `(File not found: ${path})`;
        }
        throw error;
    }
}

/**
 * Create a review comment on a specific line of a file
 */
export async function createReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    path: string,
    line: number,
    body: string,
    side: "LEFT" | "RIGHT" = "RIGHT",
    startLine?: number
): Promise<void> {
    const params: Parameters<Octokit["rest"]["pulls"]["createReviewComment"]>[0] =
    {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        path,
        body,
        line,
        side,
    };

    // Add multi-line support if startLine is provided
    if (startLine !== undefined && startLine < line) {
        params.start_line = startLine;
        params.start_side = side;
    }

    await octokit.rest.pulls.createReviewComment(params);
}

/**
 * Create a general comment on the PR (for summary)
 */
export async function createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
): Promise<void> {
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
    });
}

/**
 * Reply to a review comment (creates a reply in the same thread)
 */
export async function replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string
): Promise<void> {
    await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentId,
        body,
    });
}

/**
 * Add a reaction to an issue comment
 */
export async function addReactionToComment(
    owner: string,
    repo: string,
    commentId: number,
    reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
    await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction,
    });
}
