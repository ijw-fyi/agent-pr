/**
 * Context about the PR being reviewed
 */
export interface PRContext {
    owner: string;
    repo: string;
    prNumber: number;
    title: string;
    description: string | null;
    author: string;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    baseSha: string;
    diff: string;
    fileTree: string;
    existingComments: ReviewComment[];
    conversation: ConversationComment[];
    /** User preferences loaded from __agent_pr__ branch */
    preferences: string;
}

/**
 * An existing review comment on the PR
 */
export interface ReviewComment {
    id: number;
    author: string;
    body: string;
    path: string;
    line: number | null;
    createdAt: string;
}

/**
 * A comment in the PR conversation (issue comments)
 */
export interface ConversationComment {
    id: number;
    author: string;
    body: string;
    createdAt: string;
}

/**
 * File info in the project tree
 */
export interface FileInfo {
    path: string;
    type: "file" | "dir";
}
