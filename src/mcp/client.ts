import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parseMCPConfig, type MCPServerConfig } from "./config.js";
import { recordMCPToolCall } from "../helpers/cached-model.js";

/**
 * Active MCP client connections
 */
const clients: Map<string, Client> = new Map();

/**
 * Initialize MCP clients from configuration
 */
export async function initMCPClients(): Promise<void> {
    const config = parseMCPConfig();

    if (config.servers.length === 0) {
        console.log("No MCP servers configured");
        return;
    }

    console.log(`Initializing ${config.servers.length} MCP server(s)...`);

    for (const serverConfig of config.servers) {
        try {
            await initMCPClient(serverConfig);
            console.log(`Connected to MCP server: ${serverConfig.name}`);
        } catch (error) {
            console.error(
                `Failed to connect to MCP server '${serverConfig.name}':`,
                error
            );
        }
    }
}

/**
 * Initialize a single MCP client
 */
async function initMCPClient(config: MCPServerConfig): Promise<void> {
    const client = new Client({
        name: "pr-review-agent",
        version: "1.0.0",
    });

    if (config.transport === "stdio") {
        const transport = new StdioClientTransport({
            command: config.command!,
            args: config.args || [],
            env: {
                ...process.env,
                ...config.env,
            } as Record<string, string>,
        });

        await client.connect(transport);
    } else if (config.transport === "http") {
        // HTTP transport using StreamableHTTPClientTransport
        const transport = new StreamableHTTPClientTransport(
            new URL(config.url!)
        );

        await client.connect(transport);
    }

    clients.set(config.name, client);
}

/**
 * Get all available tools from MCP servers, converted to LangChain format
 */
export async function getMCPTools(): Promise<ReturnType<typeof tool>[]> {
    const mcpTools: ReturnType<typeof tool>[] = [];

    for (const [serverName, client] of clients) {
        try {
            const { tools: serverTools } = await client.listTools();

            for (const mcpTool of serverTools) {
                // Convert MCP tool to LangChain tool
                const langchainTool = createLangChainToolFromMCP(
                    serverName,
                    client,
                    mcpTool
                );
                mcpTools.push(langchainTool);
            }

            console.log(
                `Loaded ${serverTools.length} tool(s) from MCP server: ${serverName}`
            );
        } catch (error) {
            console.error(
                `Failed to list tools from MCP server '${serverName}':`,
                error
            );
        }
    }

    return mcpTools;
}

/**
 * Convert an MCP tool definition to a LangChain tool
 */
function createLangChainToolFromMCP(
    serverName: string,
    client: Client,
    mcpTool: {
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }
): ReturnType<typeof tool> {
    // Convert JSON Schema to Zod schema
    // For simplicity, we accept any object and let MCP server validate
    const schema = z.object({}).passthrough();

    const toolName = `${serverName}_${mcpTool.name}`;

    return tool(
        async (input) => {
            try {
                const result = await client.callTool({
                    name: mcpTool.name,
                    arguments: input as Record<string, unknown>,
                });

                // Record successful MCP tool call
                recordMCPToolCall(toolName, false);

                // Extract text content from result
                if (result.content && Array.isArray(result.content)) {
                    return result.content
                        .filter((c): c is { type: "text"; text: string } => c.type === "text")
                        .map((c) => c.text)
                        .join("\n");
                }

                return JSON.stringify(result);
            } catch (error) {
                recordMCPToolCall(toolName, true);
                return `Error calling MCP tool '${mcpTool.name}': ${error instanceof Error ? error.message : "Unknown error"}`;
            }
        },
        {
            name: toolName,
            description:
                mcpTool.description || `Tool from MCP server: ${serverName}`,
            schema,
        }
    );
}

/**
 * Cleanup: close all MCP client connections
 */
export async function closeMCPClients(): Promise<void> {
    for (const [name, client] of clients) {
        try {
            await client.close();
            console.log(`Closed MCP client: ${name}`);
        } catch (error) {
            console.error(`Error closing MCP client '${name}':`, error);
        }
    }
    clients.clear();
}
