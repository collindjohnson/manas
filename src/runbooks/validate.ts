import { access } from "node:fs/promises";

const root = new URL("../../docs/runbooks/", import.meta.url);
const required = ["README.md", "operator.md", "security.md", "backup-restore.md", "upgrade-rollback.md", "remote-git.md", "local-model.md", "postgres-failover.md", "retention.md"];
for (const name of required) {
	await access(new URL(name, root));
	const text = await Bun.file(new URL(name, root)).text();
	if (!text.trim() || !text.includes("#")) throw new Error("runbook is empty or missing a heading: " + name);
}
console.log("runbook validation passed");
