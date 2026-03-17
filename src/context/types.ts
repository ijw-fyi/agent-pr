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
    /** Commits included in this PR, in chronological order */
    commits: PRCommit[];
    diff: string;
    existingComments: ReviewComment[];
    conversation: ConversationComment[];
    /** User preferences loaded from __agent_pr__ branch */
    preferences: string;
    /** Repository guidelines loaded from CLAUDE.md */
    claudeMd: string | null;
    /** Bot's previous review summaries on this PR */
    reviewSummaries: ReviewSummary[];
    /** The authenticated bot's GitHub login (e.g., "github-actions[bot]") */
    botLogin: string;
    /** Incremental diff since last bot review (undefined if first review or --full) */
    incrementalDiff?: string;
    /** SHA of the commit used as base for incremental diff */
    lastReviewedCommitSha?: string;
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
    isResolved: boolean;
    inReplyToId: number | null;
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
 * A review summary submitted by the bot
 */
export interface ReviewSummary {
    author: string;
    body: string;
    state: string;
    submittedAt: string;
}

/**
 * A commit in the PR
 */
export interface PRCommit {
    sha: string;
    message: string;
    author: string;
    date: string;
}

/**
 * File info in the project tree
 */
export interface FileInfo {
    path: string;
    type: "file" | "dir";
}
