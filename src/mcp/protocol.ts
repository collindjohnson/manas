export const MCP_PROTOCOL_VERSION = "2024-11-05";

export function negotiateMcpProtocolVersion(params: unknown): string {
	if (!isRecord(params) || params.protocolVersion === undefined)
		return MCP_PROTOCOL_VERSION;
	if (typeof params.protocolVersion !== "string")
		throw new Error("invalid params");
	return MCP_PROTOCOL_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
