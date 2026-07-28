import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const { SerializedBrainStore } = await import(modulePath);

describe("serialized brain store", () => {
	test("does not overlap local store operations", async () => {
		let active = 0;
		let maximum = 0;
		const raw = {
			query: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((done) => setTimeout(done, 5)); active -= 1; return []; },
			exec: async () => {},
			transaction: async (action: any) => action(raw),
			close: async () => {},
		};
		const store = new SerializedBrainStore(raw);
		await Promise.all([store.query("one"), store.query("two"), store.query("three")]);
		expect(maximum).toBe(1);
	});
});
