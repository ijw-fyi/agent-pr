/**
 * Command override parsing for /review comments
 *
 * Extracts --flag value pairs from trigger comment text,
 * maps them to environment variable overrides, and returns
 * the cleaned text with flags stripped.
 */

const FLAG_CONFIG: Record<string, { envVar: string; type: 'number' | 'string' }> = {
    'budget':          { envVar: 'AGENT_PR_BUDGET', type: 'number' },
    'model':           { envVar: 'MODEL',           type: 'string' },
    'recursion-limit': { envVar: 'RECURSION_LIMIT', type: 'number' },
    'max-loc':         { envVar: 'PR_AGENT_MAX_LOC', type: 'number' },
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
        // Match --flag followed by a quoted value or a non-whitespace token
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
                overrides[config.envVar] = value;
            }

            console.log(`🔧 Override: --${flag} ${value} → ${config.envVar}=${value}`);
            stripped = stripped.replace(match[0], '');
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
