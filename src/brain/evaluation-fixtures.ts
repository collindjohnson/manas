export const EVALUATION_V2_FIXTURES = [
 { split: "development", project: "Aster", previousOwner: "Maya", currentOwner: "Rowan", code: "reconcileCheckpoint", privateWord: "privatedocket", withdrawnWord: "withdrawnaster", expiredWord: "expiredaster", futureWord: "futureaster", staleWord: "staleaster", oldWord: "supersededaster", newWord: "currentaster", graph: ["Eli", "Compass", "Birch", "Reno"], alias: "Captain Eli" },
 { split: "held-out", project: "Nacre", previousOwner: "Kai", currentOwner: "Iris", code: "renewWorkerLease", privateWord: "sealedminutes", withdrawnWord: "withdrawnnacre", expiredWord: "expirednacre", futureWord: "futurenacre", staleWord: "stalenacre", oldWord: "supersedednacre", newWord: "currentnacre", graph: ["Zoe", "Harbor", "Saffron", "Salem"], alias: "Captain Zoe" },
] as const;
export type EvaluationV2Fixture = typeof EVALUATION_V2_FIXTURES[number];
export const EVALUATION_V2_POLICY = {
 version: 1,
 mode: "keyword",
 maximumResults: 10,
 phases: ["initial", "corrected", "withdrawn", "permission-changed", "rebuilt", "replayed"],
 graphPredicates: ["owns", "belongs-to", "based-in"],
 graphPrivateIndex: 2,
 expiredUntil: "2000-01-01T00:00:00.000Z",
 futureFrom: "9999-01-01T00:00:00.000Z",
};
export function evaluationV2Documents(fixture: EvaluationV2Fixture) {
 return [
  { id: "session-owner", text: "User: " + fixture.project + " owner is " + fixture.previousOwner + ".\nAssistant: The owner is recorded for our next session.", updatedAt: "2026-09-01T12:00:00.000Z", labels: [] },
  { id: "session-decision", text: "User: " + fixture.project + " launch decision sets the deadline to October 14, 2026.\nAssistant: The decision deadline is recorded.", updatedAt: "2026-09-20T12:00:00.000Z", labels: [] },
  { id: "code", text: "User: " + fixture.code + " commits a retry receipt before advancing the source cursor.", updatedAt: "2026-09-21T12:00:00.000Z", labels: [] },
  { id: "noise", text: Array.from({ length: 32 }, (_, index) => "Tool: " + fixture.project + " build " + index + " passed. Assistant: retry tool output, waiting, build passed.").join("\n"), updatedAt: "2026-09-22T12:00:00.000Z", labels: [] },
  { id: "private", text: "The " + fixture.privateWord + " contains a private meeting agenda.", updatedAt: "2026-09-23T12:00:00.000Z", labels: ["private"] },
  { id: "stale", text: "The " + fixture.staleWord + " record is no longer maintained by its source.", updatedAt: "2026-09-24T12:00:00.000Z", labels: [] },
  { id: "generated", text: "Generated answer claims " + fixture.project + " has a fictional owner. " + fixture.newWord, updatedAt: "2026-09-25T12:00:00.000Z", labels: [] },
 ];
}
export function evaluationV2Memories(fixture: EvaluationV2Fixture) {
 const [person, project, organization, place] = fixture.graph;
 return [
  { id: "memory-owner", text: fixture.project + " owner is " + fixture.previousOwner + ". " + fixture.oldWord },
  { id: "memory-withdrawn", text: fixture.withdrawnWord + " is an assertion to withdraw." },
  { id: "memory-expired", text: fixture.expiredWord + " was valid in the distant past.", validUntil: EVALUATION_V2_POLICY.expiredUntil },
  { id: "memory-future", text: fixture.futureWord + " is not valid yet.", validFrom: EVALUATION_V2_POLICY.futureFrom },
  { id: "memory-graph", text: person + " owns " + project + ". " + project + " belongs to " + organization + ". " + organization + " is based in " + place + "." },
 ];
}
export type EvaluationV2Case = { id: string; phase: string; surface: "search" | "recall" | "relationships"; query?: string; expectedIds: string[]; labels?: string[]; options?: Record<string, unknown>; graph?: Record<string, unknown>; deniedTenant?: boolean };
export function evaluationV2Cases(fixture: EvaluationV2Fixture): EvaluationV2Case[] {
 const [person, project, organization, place] = fixture.graph;
 return [
  { id: "cross-session-owner", phase: "initial", surface: "search", query: fixture.project + " owner", expectedIds: ["memory-owner", "session-owner"] },
  { id: "cross-session-decision", phase: "initial", surface: "search", query: fixture.project + " decision deadline", expectedIds: ["session-decision"] },
  { id: "noisy-transcript", phase: "initial", surface: "search", query: fixture.code + " retry receipt", expectedIds: ["code"] },
  { id: "temporal-user-filter", phase: "initial", surface: "search", query: fixture.project, options: { after: "2026-09-10T00:00:00.000Z", role: "user" }, expectedIds: ["session-decision"] },
  { id: "private-denied", phase: "initial", surface: "search", query: fixture.privateWord, expectedIds: [] },
  { id: "private-authorized", phase: "initial", surface: "search", query: fixture.privateWord, labels: ["private"], expectedIds: ["private"] },
  { id: "tenant-denied", phase: "initial", surface: "search", query: fixture.project, deniedTenant: true, expectedIds: [] },
  { id: "stale-source", phase: "initial", surface: "search", query: fixture.staleWord, expectedIds: [] },
  { id: "expired-search", phase: "initial", surface: "search", query: fixture.expiredWord, expectedIds: [] },
  { id: "future-search", phase: "initial", surface: "search", query: fixture.futureWord, expectedIds: [] },
  { id: "recall-contract", phase: "initial", surface: "recall", query: fixture.oldWord, expectedIds: ["memory-owner"] },
  { id: "withdraw-before", phase: "initial", surface: "search", query: fixture.withdrawnWord, expectedIds: ["memory-withdrawn"] },
  { id: "graph-one-hop", phase: "initial", surface: "relationships", graph: { from: person, to: project, maximumDepth: 1 }, expectedIds: ["owns"] },
  { id: "graph-private-intermediate", phase: "initial", surface: "relationships", graph: { from: person, to: place, maximumDepth: 3 }, expectedIds: [] },
  { id: "graph-three-hop", phase: "initial", surface: "relationships", graph: { from: person, to: place, maximumDepth: 3 }, labels: ["private"], expectedIds: ["owns>belongs-to>based-in"] },
  { id: "graph-hop-bound", phase: "initial", surface: "relationships", graph: { from: person, to: place, maximumDepth: 2 }, labels: ["private"], expectedIds: [] },
  { id: "graph-alias-two-hop", phase: "initial", surface: "relationships", graph: { from: fixture.alias, to: organization, maximumDepth: 2 }, labels: ["private"], expectedIds: ["owns>belongs-to"] },
  { id: "old-assertion-suppressed", phase: "corrected", surface: "search", query: fixture.oldWord, expectedIds: [] },
  { id: "current-assertion", phase: "corrected", surface: "search", query: fixture.newWord, expectedIds: ["memory-owner"] },
  { id: "current-recall", phase: "corrected", surface: "recall", query: fixture.newWord, expectedIds: ["memory-owner"] },
  { id: "withdrawn-search", phase: "withdrawn", surface: "search", query: fixture.withdrawnWord, expectedIds: [] },
  { id: "withdrawn-recall", phase: "withdrawn", surface: "recall", query: fixture.withdrawnWord, expectedIds: [] },
  { id: "withdrawn-graph", phase: "withdrawn", surface: "relationships", graph: { from: person, to: place, maximumDepth: 3 }, labels: ["private"], expectedIds: [] },
  { id: "changed-access-denied", phase: "permission-changed", surface: "search", query: fixture.project + " deadline", expectedIds: [] },
  { id: "changed-access-authorized", phase: "permission-changed", surface: "search", query: fixture.project + " deadline", labels: ["private"], expectedIds: ["session-decision"] },
  { id: "rebuild-withdrawal", phase: "rebuilt", surface: "search", query: fixture.withdrawnWord, expectedIds: [] },
  { id: "rebuild-correction", phase: "rebuilt", surface: "search", query: fixture.newWord, expectedIds: ["memory-owner"] },
  { id: "rebuild-graph", phase: "rebuilt", surface: "relationships", graph: { from: person, to: place, maximumDepth: 3 }, labels: ["private"], expectedIds: [] },
  { id: "replayed-capture-withdrawal", phase: "replayed", surface: "recall", query: fixture.withdrawnWord, expectedIds: [] },
 ];
}
