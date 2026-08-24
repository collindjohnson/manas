export interface ParsedGlobalArguments {
	args: string[];
	configPath?: string;
}

export function parseGlobalArguments(input: string[]): ParsedGlobalArguments {
	const args: string[] = [];
	let configPath: string | undefined;
	for (let index = 0; index < input.length; index += 1) {
		const value = input[index]!;
		if (value.startsWith("--config=")) throw new Error("use --config <path>, not --config=<path>");
		if (value !== "--config") {
			args.push(value);
			continue;
		}
		if (configPath !== undefined) throw new Error("duplicate option --config");
		const candidate = input[index + 1];
		if (!candidate || candidate.startsWith("--")) throw new Error("missing value for --config");
		configPath = candidate;
		index += 1;
	}
	return { args, ...(configPath === undefined ? {} : { configPath }) };
}
