const slash = String.fromCharCode(47);
const expectedImports = [
	["@manas-pglite-assets", "pglite.data"].join(slash),
	["@manas-pglite-assets", "pglite.wasm"].join(slash),
	["@manas-pglite-assets", "initdb.wasm"].join(slash),
	["@manas-pgvector-assets", "vector.tar.gz"].join(slash),
];
const store = await Bun.file(["src", "brain", "store.ts"].join(slash)).text();
for (const specifier of expectedImports)
	if (!store.includes(specifier)) throw new Error(`missing literal embedded asset import: ${specifier}`);

const files = [
	["node_modules", "@electric-sql", "pglite", "dist", "pglite.data"].join(slash),
	["node_modules", "@electric-sql", "pglite", "dist", "pglite.wasm"].join(slash),
	["node_modules", "@electric-sql", "pglite", "dist", "initdb.wasm"].join(slash),
	["node_modules", "@electric-sql", "pglite-pgvector", "dist", "vector.tar.gz"].join(slash),
];
for (const path of files)
	if (!(await Bun.file(path).exists())) throw new Error(`required embedded asset is unavailable: ${path}`);
