export const MCP_CONFIGURATION_UNAVAILABLE_MESSAGE =
	"MCP configuration unavailable: MANAS_BRAIN_REPOSITORY must point to an initialized Manas brain repository";

export class McpConfigurationUnavailableError extends Error {
	constructor() {
		super(MCP_CONFIGURATION_UNAVAILABLE_MESSAGE);
		this.name = "McpConfigurationUnavailableError";
	}
}

export function mcpConfigurationUnavailableError(): McpConfigurationUnavailableError {
	return new McpConfigurationUnavailableError();
}

export function isMcpConfigurationUnavailableError(error: unknown): error is McpConfigurationUnavailableError {
	return error instanceof McpConfigurationUnavailableError;
}

export function mcpErrorDetails(error: unknown, cancelled = false): { code: number; message: string; data?: { code: string; retryable: boolean; suggestedFix: string } } {
	if (cancelled) return { code: -32800, message: "request cancelled" };
	const domain = error as { code?: unknown; retryable?: unknown; suggestedFix?: unknown };
	if (error instanceof Error && typeof domain.code === "string" && typeof domain.retryable === "boolean" && typeof domain.suggestedFix === "string") return { code: -32000, message: error.message, data: { code: domain.code, retryable: domain.retryable, suggestedFix: domain.suggestedFix } };
	if (error instanceof Error && error.message === "invalid params") return { code: -32602, message: "invalid params" };
	if (isMcpConfigurationUnavailableError(error)) return { code: -32000, message: MCP_CONFIGURATION_UNAVAILABLE_MESSAGE };
	return { code: -32603, message: "internal error" };
}


export class McpClientPermissionError extends Error {
 readonly code = "client_operation_unavailable";
 readonly retryable = false;
 readonly suggestedFix = "Use an operation advertised for this client, or ask the owner to update its grant.";
 constructor() { super("operation is not available to this client"); }
}
