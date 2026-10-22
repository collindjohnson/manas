import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { enqueueJob, runOneJob } from "../src/brain/jobs";
import { maintenanceScanHandler, maintenanceProposals } from "../src/brain/maintenance-scan";

test("window checkpoints and continuation jobs survive an operational store restart", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-window-reopen-"));
 const repository = new BrainRepository(join(root, "brain"));
 const state = join(root, "state");
 let store = await openPgliteBrainStore(state);
 let calls = 0;
 const provider = { id: "restart-window", generate: async (prompt: string) => {
  calls++;
  const source = JSON.parse(prompt.slice(prompt.lastIndexOf("Source: ") + 8)) as string;
  const spans = [...source.matchAll(/FACT:[^\n]+/g)].map((match) => ({ start: match.index, end: match.index! + match[0].length }));
  return JSON.stringify({ spans });
 } };
 try {
  await repository.initialize();
  await repository.putPage("notes/long.md", "FACT: Maya owns Juniper.\n" + "x".repeat(14950) + "\nFACT: Sam owns Cedar.\n" + "y".repeat(14950) + "\nFACT: Iris owns Orchid.");
  const brainId = (await repository.getIdentity()).brainId;
  await enqueueJob(store, { type: "maintenance-scan", payload: { brainId, maximumItems: 1 } });
  const handler = maintenanceScanHandler({ repository, store, provider, workerId: "before" });
  expect(await runOneJob(store, "before", { "maintenance-scan": handler })).toMatchObject({ status: "complete" });
  expect(calls).toBe(1);
  await store.close();
  store = await openPgliteBrainStore(state);
  const reopened = new BrainRepository(repository.root);
  const resumed = maintenanceScanHandler({ repository: reopened, store, provider, workerId: "after" });
  for (let index = 0; index < 2; index++) expect(await runOneJob(store, "after", { "maintenance-scan": resumed })).toMatchObject({ status: "complete" });
  expect(await runOneJob(store, "after", { "maintenance-scan": resumed })).toBeUndefined();
  expect(calls).toBe(3);
  expect(await store.query("SELECT completed FROM brain_maintenance_analysis WHERE completed=false")).toEqual([]);
  const proposals = await maintenanceProposals(reopened, { scope: "admin" });
  expect(proposals.items).toHaveLength(3);
  expect(proposals.items.every((item) => item.freshness === "current")).toBe(true);
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);
