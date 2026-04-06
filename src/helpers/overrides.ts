/**
 * Command override parsing for /review comments
 *
 * Extracts --flag value pairs from trigger comment text,
 * maps them to environment variable overrides, and returns
 * the cleaned text with flags stripped.
 */

const FLAG_CONFIG: Record<string, { envVar: string; type: 'number' | 'string' | 'boolean'; multi?: boolean; value?: string }> = {
    'budget':          { envVar: 'AGENT_PR_BUDGET',  type: 'number' },
    'model':           { envVar: 'MODEL',            type: 'string' },
    'recursion-limit': { envVar: 'RECURSION_LIMIT',  type: 'number' },
    'max-loc':         { envVar: 'PR_AGENT_MAX_LOC', type: 'number' },
    'ignore':          { envVar: 'PR_AGENT_IGNORE',  type: 'string', multi: true },
    'mode':            { envVar: 'REVIEW_MODE',      type: 'string' },
    'full':            { envVar: 'PR_AGENT_FULL_DIFF', type: 'boolean' },
    'single':          { envVar: 'REVIEW_MODE',      type: 'boolean', value: 'single' },
    'multi':           { envVar: 'REVIEW_MODE',      type: 'boolean', value: 'orchestrated' },
};

const MODEL_ALIASES: Record<string, string> = {
    'opus':   'anthropic/claude-opus-4.6',
    'sonnet': 'anthropic/claude-sonnet-4.5',
    'sonet':  'anthropic/claude-sonnet-4.5',
};

export interface ParsedOverrides {
    overrides: Record<string, string>;
    strippedText: string;
}

/**
 * Parse --flag value pairs from a comment body and return
 * the env var overrides and the text with flags removed.
 */
export function parseCommandOverrides(commentBody: string): ParsedOverrides {
    if (!commentBody) {
        return { overrides: {}, strippedText: '' };
    }

    const overrides: Record<string, string> = {};
    let stripped = commentBody;

    for (const [flag, config] of Object.entries(FLAG_CONFIG)) {
        if (config.type === 'boolean') {
            // Boolean flags: --flag with no value
            const pattern = new RegExp(`--${flag}(?=\\s|$)`, 'gi');
            if (pattern.test(stripped)) {
                const flagValue = config.value ?? 'true';
                overrides[config.envVar] = flagValue;
                console.log(`🔧 Override: --${flag} → ${config.envVar}=${flagValue}`);
                stripped = stripped.replace(pattern, '');
            }
        } else if (config.multi) {
            // Match all occurrences for multi-value flags (needs g flag for matchAll)
            const pattern = new RegExp(`--${flag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'gi');
            const values: string[] = [];
            for (const match of stripped.matchAll(pattern)) {
                values.push(match[1] ?? match[2] ?? match[3]);
            }
            if (values.length > 0) {
                overrides[config.envVar] = values.join(',');
                console.log(`🔧 Override: --${flag} [${values.join(', ')}] → ${config.envVar}=${overrides[config.envVar]}`);
                stripped = stripped.replace(pattern, '');
            }
        } else {
            // Single-value flag (no g flag to preserve capture groups in match())
            const pattern = new RegExp(`--${flag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'i');
            const match = stripped.match(pattern);

            if (match) {
                const value = match[1] ?? match[2] ?? match[3];

                if (config.type === 'number') {
                    const parsed = parseFloat(value);
                    if (isNaN(parsed) || parsed <= 0) {
                        console.warn(`⚠️ Invalid value for --${flag}: "${value}" (expected positive number, skipping)`);
                        // Still strip the flag from text
                        stripped = stripped.replace(match[0], '');
                        continue;
                    }
                    overrides[config.envVar] = value;
                } else {
                    overrides[config.envVar] = config.envVar === 'MODEL'
                        ? (MODEL_ALIASES[value.toLowerCase()] ?? value)
                        : value;
                }

                console.log(`🔧 Override: --${flag} ${value} → ${config.envVar}=${value}`);
                stripped = stripped.replace(match[0], '');
            }
        }
    }

    // Collapse multiple spaces into one and trim
    stripped = stripped.replace(/  +/g, ' ').trim();

    return { overrides, strippedText: stripped };
}

/**
 * Apply parsed overrides to process.env
 */
export function applyOverrides(overrides: Record<string, string>): void {
    for (const [envVar, value] of Object.entries(overrides)) {
        process.env[envVar] = value;
    }
}

/**
 * Find the /review trigger comment body from a list of comments.
 * Uses TRIGGER_COMMENT_ID if available, otherwise finds the last
 * comment starting with /review.
 */
export function findReviewCommentBody(comments: Array<{ id?: number; body: string }>): string | null {
    const triggerCommentId = process.env.TRIGGER_COMMENT_ID;

    // Try matching by ID first
    if (triggerCommentId) {
        const id = parseInt(triggerCommentId, 10);
        const match = comments.find(c => c.id === id);
        if (match) return match.body;
    }

    // Fall back to last comment starting with /review
    for (let i = comments.length - 1; i >= 0; i--) {
        if (comments[i].body.trimStart().startsWith('/review')) {
            return comments[i].body;
        }
    }

    return null;
}

/**
 * Parse overrides from a review comment body, apply them to process.env,
 * and return the stripped text.
 */
export function processReviewOverrides(commentBody: string): string {
    const { overrides, strippedText } = parseCommandOverrides(commentBody);
    if (Object.keys(overrides).length > 0) {
        applyOverrides(overrides);
        console.log(`Applied ${Object.keys(overrides).length} override(s) from comment`);
    }
    return strippedText;
}

/**
 * Strip --flag value patterns from text without parsing overrides.
 * Use this to clean all comments so the agent never sees raw flags.
 */
export function stripOverrideFlags(text: string): string {
    if (!text) return text;
    let stripped = text;
    for (const [flag, config] of Object.entries(FLAG_CONFIG)) {
        if (config.type === 'boolean') {
            const pattern = new RegExp(`--${flag}(?=\\s|$)`, 'gi');
            stripped = stripped.replace(pattern, '');
        } else {
            const pattern = new RegExp(`--${flag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'gi');
            stripped = stripped.replace(pattern, '');
        }
    }
    return stripped.replace(/  +/g, ' ').trim();
}
