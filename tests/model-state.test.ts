import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "model-state"].join(String.fromCharCode(47));
const { activatePersistedModel, loadActiveModels, ModelActivationCoordinator, persistModelActivation } = await import(modulePath);
const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);

describe("replacement model activation", () => {
	test("builds coverage privately, atomically activates, and rolls back within the window", () => {
		const coordinator = new ModelActivationCoordinator();
		const first = coordinator.begin({ kind: "embedding", provider: "local", model: "one", dimensions: 2, privacy: "local" }, 2, 2);
		coordinator.record(first.fingerprint, 2);
		coordinator.activate(first.fingerprint, new Date("2026-01-01T00:00:00Z"));
		const second = coordinator.begin({ kind: "embedding", provider: "local", model: "two", dimensions: 2, privacy: "local" }, 2, 2);
		expect(() => coordinator.activate(second.fingerprint)).toThrow("incomplete");
		coordinator.record(second.fingerprint, 2);
		expect(coordinator.activate(second.fingerprint, new Date("2026-01-02T00:00:00Z")).status).toBe("active");
		expect(coordinator.rollback(new Date("2026-01-02T01:00:00Z")).descriptor.model).toBe("one");
	});

	test("does not activate a partially covered replacement", () => {
		const coordinator = new ModelActivationCoordinator();
		const activation = coordinator.begin({ kind: "reranking", provider: "local", model: "ranker", privacy: "local" }, 1, 1);
		expect(() => coordinator.activate(activation.fingerprint)).toThrow("incomplete");
	});

	test("persists active model descriptors by tenant and brain", async () => {
		const store = await openPgliteBrainStore();
		try {
			const coordinator = new ModelActivationCoordinator();
			const activation = coordinator.begin({ kind: "generation", provider: "local", model: "one", privacy: "local" }, 0, 1);
			coordinator.record(activation.fingerprint, 0);
			const active = coordinator.activate(activation.fingerprint);
			await persistModelActivation(store, active, "tenant", "brain");
			expect(await loadActiveModels(store, "tenant", "brain")).toMatchObject([{ descriptor: { model: "one" } }]);
			const replacement = { ...active, id: "replacement", fingerprint: "replacement-fingerprint", descriptor: { ...active.descriptor, model: "two" } };
			await activatePersistedModel(store, replacement, "tenant", "brain");
			expect(await loadActiveModels(store, "tenant", "brain")).toMatchObject([{ descriptor: { model: "two" } }]);
		} finally { await store.close(); }
	});
});
