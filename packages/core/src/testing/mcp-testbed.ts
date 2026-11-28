import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginPackage } from "../kernel.ts";
import { type ApiInstance, startApiInstance } from "./api-instance.ts";

export const MCP_PATH = "/api/mcp";

export type McpTestbed = {
	startInstance(plugins: readonly PluginPackage[]): Promise<ApiInstance>;
	connectedClient(instanceUrl: string, token: string): Promise<Client>;
	tearDown(): Promise<void>;
};

export function mcpTestbed(): McpTestbed {
	const instances: ApiInstance[] = [];
	const clients: Client[] = [];
	return {
		startInstance: async (plugins) => {
			const instance = await startApiInstance(plugins);
			instances.push(instance);
			return instance;
		},
		connectedClient: async (instanceUrl, token) => {
			const client = new Client({ name: "test-agent", version: "1.0.0" });
			clients.push(client);
			await client.connect(
				new StreamableHTTPClientTransport(
					new URL(`${instanceUrl}${MCP_PATH}`),
					{
						requestInit: { headers: { Authorization: `Bearer ${token}` } },
					},
				),
			);
			return client;
		},
		tearDown: async () => {
			for (const client of clients.splice(0)) await client.close();
			for (const instance of instances.splice(0)) await instance.stop();
		},
	};
}
