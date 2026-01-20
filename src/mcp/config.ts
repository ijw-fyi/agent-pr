/**
 * MCP server configuration
 */
export interface MCPServerConfig {
    name: string;
    transport: "stdio" | "http";
    command?: string; // For stdio transport
    args?: string[]; // For stdio transport
    url?: string; // For http transport
    env?: Record<string, string>; // Environment variables for the process
}

/**
 * Full MCP configuration from environment
 */
export interface MCPConfig {
    servers: MCPServerConfig[];
}

/**
 * Parse MCP configuration from environment variable
 */
export function parseMCPConfig(): MCPConfig {
    const configStr = process.env.MCP_CONFIG || "{}";

    try {
        const parsed = JSON.parse(configStr);

        // Validate structure
        if (!parsed.servers) {
            return { servers: [] };
        }

        if (!Array.isArray(parsed.servers)) {
            console.warn("MCP_CONFIG.servers is not an array, ignoring");
            return { servers: [] };
        }

        // Validate each server config
        const servers: MCPServerConfig[] = parsed.servers
            .filter((server: unknown) => {
                if (typeof server !== "object" || server === null) {
                    console.warn("Invalid MCP server config (not an object), skipping");
                    return false;
                }

                const s = server as Record<string, unknown>;

                if (!s.name || typeof s.name !== "string") {
                    console.warn("MCP server config missing 'name', skipping");
                    return false;
                }

                if (!s.transport || !["stdio", "http"].includes(s.transport as string)) {
                    console.warn(
                        `MCP server '${s.name}' has invalid transport, skipping`
                    );
                    return false;
                }

                if (s.transport === "stdio" && !s.command) {
                    console.warn(
                        `MCP server '${s.name}' with stdio transport missing 'command', skipping`
                    );
                    return false;
                }

                if (s.transport === "http" && !s.url) {
                    console.warn(
                        `MCP server '${s.name}' with http transport missing 'url', skipping`
                    );
                    return false;
                }

                return true;
            })
            .map((server: Record<string, unknown>) => ({
                name: server.name as string,
                transport: server.transport as "stdio" | "http",
                command: server.command as string | undefined,
                args: (server.args as string[]) || [],
                url: server.url as string | undefined,
                env: (server.env as Record<string, string>) || {},
            }));

        return { servers };
    } catch (error) {
        console.warn("Failed to parse MCP_CONFIG:", error);
        return { servers: [] };
    }
}
