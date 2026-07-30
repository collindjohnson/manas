import ts from "typescript";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const violations: string[] = [];

function isDynamicImportExpression(node: ts.Node): boolean {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
	return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
		? isDynamicImportExpression(node.expression)
		: false;
}

function visit(sourceFile: ts.SourceFile, node: ts.Node): void {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		const argument = node.arguments[0];
		if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			violations.push(`${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: dynamic import must use a string literal`);
		}
	}
	if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword && isDynamicImportExpression(node.expression)) {
		const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		violations.push(`${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: dynamic imports must not use an any cast`);
	}
	ts.forEachChild(node, (child) => visit(sourceFile, child));
}

async function runtimeFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map(async (entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return runtimeFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	}));
	return nested.flat();
}

for (const path of await runtimeFiles(import.meta.dir)) {
	const source = await Bun.file(path).text();
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
	visit(sourceFile, sourceFile);
}

if (violations.length) {
	console.error(violations.join("\n"));
	process.exit(1);
}
