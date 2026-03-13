#!/usr/bin/env node
/**
 * MCP Gateway Server Example
 *
 * This server acts as a proxy MCP that forwards tool calls to downstream MCP servers.
 * When downstream tools require x402 payment, the gateway wallet pays automatically.
 */
import { config } from "dotenv";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";

config();

type JsonObject = Record<string, unknown>;
type DownstreamTransportMode = "auto" | "sse" | "streamable-http";

type DownstreamMcpClient = ReturnType<typeof createx402MCPClient>;

interface DownstreamServiceRecord {
  serviceId: string;
  url: string;
  transport: Exclude<DownstreamTransportMode, "auto">;
  client: DownstreamMcpClient;
  tools: Array<{ name: string; description?: string }>;
}

const evmPrivateKey = requireHexPrivateKey("EVM_PRIVATE_KEY");

const rawDownstreamUrls = process.env.DOWNSTREAM_MCP_URLS ?? process.env.DOWNSTREAM_MCP_URL;
if (!rawDownstreamUrls) {
  console.error("DOWNSTREAM_MCP_URL or DOWNSTREAM_MCP_URLS environment variable is required");
  process.exit(1);
}

const downstreamUrls = rawDownstreamUrls
  .split(",")
  .map(url => url.trim())
  .filter(Boolean);

if (downstreamUrls.length === 0) {
  console.error("At least one downstream MCP URL is required");
  process.exit(1);
}

const transportMode = parseTransportMode(process.env.DOWNSTREAM_MCP_TRANSPORT);
const connectRetries = parseConnectRetries(process.env.DOWNSTREAM_CONNECT_RETRIES);

/**
 * Reads required hex private key from environment.
 *
 * @param envName - Environment variable name.
 * @returns Hex-prefixed private key.
 */
function requireHexPrivateKey(envName: string): `0x${string}` {
  const value = process.env[envName];
  if (!value) {
    console.error(`${envName} environment variable is required`);
    process.exit(1);
  }
  if (!value.startsWith("0x")) {
    throw new Error(`${envName} must start with 0x.`);
  }
  return value as `0x${string}`;
}

/**
 * Parses configured transport mode.
 *
 * @param value - Optional environment value.
 * @returns Parsed transport mode.
 */
function parseTransportMode(value?: string): DownstreamTransportMode {
  if (!value) {
    return "auto";
  }

  if (value === "auto" || value === "sse" || value === "streamable-http") {
    return value;
  }

  throw new Error(
    `Invalid DOWNSTREAM_MCP_TRANSPORT: ${value}. Expected one of auto|sse|streamable-http.`,
  );
}

/**
 * Parses configured retry count for downstream connection.
 *
 * @param value - Optional environment value.
 * @returns Retry count in the range [1, 10].
 */
function parseConnectRetries(value?: string): number {
  if (!value) {
    return 3;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`Invalid DOWNSTREAM_CONNECT_RETRIES: ${value}. Expected integer in [1,10].`);
  }
  return parsed;
}

/**
 * Sleeps for the provided milliseconds.
 *
 * @param ms - Milliseconds to wait.
 * @returns Promise resolved after delay.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Picks preferred transport order.
 *
 * In auto mode, always try Streamable HTTP first, then fallback to SSE.
 *
 * @param mode - Global transport mode.
 * @returns Ordered transport candidates.
 */
function getTransportCandidates(
  mode: DownstreamTransportMode,
): Array<Exclude<DownstreamTransportMode, "auto">> {
  if (mode === "sse") {
    return ["sse"];
  }
  if (mode === "streamable-http") {
    return ["streamable-http"];
  }
  return ["streamable-http", "sse"];
}

/**
 * Connects x402 MCP client with transport auto-fallback.
 *
 * @param client - x402 MCP client.
 * @param url - Downstream endpoint URL.
 * @param mode - Transport mode configuration.
 * @returns Selected transport mode after successful connection.
 */
async function connectWithTransportFallback(
  client: DownstreamMcpClient,
  url: string,
  mode: DownstreamTransportMode,
): Promise<Exclude<DownstreamTransportMode, "auto">> {
  const candidates = getTransportCandidates(mode);
  const errors: string[] = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
      try {
        const transport =
          candidate === "sse"
            ? new SSEClientTransport(new globalThis.URL(url))
            : new StreamableHTTPClientTransport(new globalThis.URL(url), {
                // Some providers strictly require both media types on streamable HTTP.
                requestInit: {
                  headers: {
                    Accept: "application/json, text/event-stream",
                  },
                },
              });
        await client.connect(transport);
        return candidate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Avoid relying on Error.cause typing for older TS lib targets.
        const cause = extractErrorCause(error);
        errors.push(`${candidate}#${attempt}: ${message}${cause}`);
        if (attempt < connectRetries) {
          await sleep(300 * attempt);
        }
      }
    }
  }

  throw new Error(`Failed to connect downstream MCP at ${url}. Attempts => ${errors.join(" | ")}`);
}

/**
 * Extracts human-readable nested error cause string.
 *
 * @param error - Unknown error value.
 * @returns Formatted cause suffix including leading space when present.
 */
function extractErrorCause(error: unknown): string {
  if (!(error instanceof Error)) {
    return "";
  }
  const maybeCause = (error as { cause?: unknown }).cause;
  if (maybeCause instanceof Error) {
    return ` (cause: ${maybeCause.message})`;
  }
  if (typeof maybeCause === "string" && maybeCause.length > 0) {
    return ` (cause: ${maybeCause})`;
  }
  return "";
}

/**
 * Creates and connects an x402 MCP client for one downstream endpoint.
 *
 * @param serviceId - Logical service identifier in the registry.
 * @param url - URL of downstream MCP server.
 * @param privateKey - Wallet private key used to pay downstream x402 challenges.
 * @param mode - Configured transport mode.
 * @returns Connected x402 MCP client instance and selected transport.
 */
async function createAndConnectDownstreamClient(
  serviceId: string,
  url: string,
  privateKey: `0x${string}`,
  mode: DownstreamTransportMode,
): Promise<{
  client: DownstreamMcpClient;
  transport: Exclude<DownstreamTransportMode, "auto">;
}> {
  const signer = privateKeyToAccount(privateKey);
  const client = createx402MCPClient({
    name: `gateway-${serviceId}`,
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }],
    autoPayment: true,
    onPaymentRequested: async context => {
      const accepted = context.paymentRequired.accepts[0];
      console.error(
        `[payment] service=${serviceId} tool=${context.toolName} amount=${accepted.amount} network=${accepted.network}`,
      );
      return true;
    },
  });

  const selectedTransport = await connectWithTransportFallback(client, url, mode);
  return { client, transport: selectedTransport };
}

/**
 * Builds the downstream service registry from configured URLs.
 *
 * @param urls - URLs for downstream MCP servers.
 * @param privateKey - Wallet private key used by gateway for payment.
 * @param mode - Configured transport mode.
 * @returns Connected service records with discovered tool list.
 */
async function initializeDownstreamRegistry(
  urls: string[],
  privateKey: `0x${string}`,
  mode: DownstreamTransportMode,
): Promise<DownstreamServiceRecord[]> {
  const records: DownstreamServiceRecord[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const serviceId = `service-${index + 1}`;
    const url = urls[index];
    const { client, transport } = await createAndConnectDownstreamClient(
      serviceId,
      url,
      privateKey,
      mode,
    );
    const toolResult = await client.listTools();
    const tools = toolResult.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
    records.push({ serviceId, url, transport, client, tools });

    console.error(`[registry] ${serviceId} connected -> ${url}`);
    console.error(`[registry] ${serviceId} transport -> ${transport}`);
    console.error(
      `[registry] ${serviceId} tools -> ${tools.map(tool => tool.name).join(", ") || "none"}`,
    );
  }

  return records;
}

/**
 * Finds one service by id, or returns the default first service.
 *
 * @param registry - Initialized downstream service records.
 * @param serviceId - Optional requested service id.
 * @returns Matching service record.
 */
function selectService(
  registry: DownstreamServiceRecord[],
  serviceId?: string,
): DownstreamServiceRecord {
  if (!serviceId) {
    return registry[0];
  }

  const service = registry.find(item => item.serviceId === serviceId);
  if (!service) {
    throw new Error(`Unknown serviceId: ${serviceId}`);
  }

  return service;
}

/**
 * Registers gateway tools that proxy calls into downstream services.
 *
 * @param mcpServer - Gateway MCP server.
 * @param registry - Downstream service registry.
 */
function registerGatewayTools(mcpServer: McpServer, registry: DownstreamServiceRecord[]): void {
  mcpServer.tool(
    "list_gateway_services",
    "List downstream services and their tools.",
    {},
    async () => {
      const result = registry.map(service => ({
        serviceId: service.serviceId,
        url: service.url,
        transport: service.transport,
        tools: service.tools,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  mcpServer.tool(
    "call_service_tool",
    "Call a downstream MCP tool via gateway. Payment is handled by gateway wallet.",
    {
      serviceId: z.string().optional().describe("Optional service id, default is service-1"),
      toolName: z.string().describe("Downstream tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments passed to downstream tool"),
    },
    async (args: { serviceId?: string; toolName: string; args?: JsonObject }) => {
      const service = selectService(registry, args.serviceId);

      const result = await service.client.callTool(args.toolName, args.args ?? {});
      const response = {
        serviceId: service.serviceId,
        toolName: args.toolName,
        paymentMade: result.paymentMade ?? false,
        paymentResponse: result.paymentResponse ?? null,
        content: result.content,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}

/**
 * Builds a configured gateway MCP server instance.
 *
 * @param registry - Downstream service registry.
 * @returns Gateway MCP server.
 */
function buildGatewayMcpServer(registry: DownstreamServiceRecord[]): McpServer {
  const mcpServer = new McpServer({
    name: "x402 Gateway MCP",
    version: "1.0.0",
  });
  registerGatewayTools(mcpServer, registry);
  return mcpServer;
}

/**
 * Starts gateway on stdio transport.
 *
 * @param registry - Downstream service registry.
 * @returns Promise resolved after stdio transport is attached.
 */
async function startGatewayServer(registry: DownstreamServiceRecord[]): Promise<void> {
  const mcpServer = buildGatewayMcpServer(registry);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Use stderr logs to avoid interfering with stdio JSON-RPC payloads.
  console.error("Gateway MCP server running on stdio transport");
  console.error(`Downstream services: ${registry.map(item => item.serviceId).join(", ")}`);
}

/**
 * Gracefully closes all downstream clients.
 *
 * @param registry - Downstream service registry with active clients.
 */
async function closeDownstreamClients(registry: DownstreamServiceRecord[]): Promise<void> {
  await Promise.all(registry.map(service => service.client.close()));
}

/**
 * Main entry point for gateway server.
 *
 * @returns Promise resolved after server initialization.
 */
export async function main(): Promise<void> {
  const registry = await initializeDownstreamRegistry(downstreamUrls, evmPrivateKey, transportMode);
  await startGatewayServer(registry);

  process.on("SIGINT", async () => {
    console.error("\nShutting down gateway...");
    await closeDownstreamClients(registry);
    process.exit(0);
  });
}

main().catch(async error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
