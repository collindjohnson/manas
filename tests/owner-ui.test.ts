import { request } from "node:http";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { createOwnerSession, authorizeOwnerSession, revokeOwnerSession } from "../src/brain/owner-sessions";
import { openPgliteBrainStore } from "../src/brain/store";
import { DurableControlPlane } from "../src/brain/control-plane";
test("owner sessions enforce brain, origin, CSRF, expiry and revocation independently of MCP web sessions", async () => {
 const store = await openPgliteBrainStore();
 try {
  const now = new Date("2030-01-01T00:00:00Z"), origin = "http://127.0.0.1:1234";
  const session = await createOwnerSession(store, "brain", origin, now);
  await authorizeOwnerSession(store, "brain", origin, session.id, session.csrf, now);
  for (const [brain, url, id, csrf] of [["other", origin, session.id, session.csrf], ["brain", origin + "0", session.id, session.csrf], ["brain", origin, session.id, "x".repeat(43)]]) await expect(authorizeOwnerSession(store, brain!, url!, id!, csrf!, now)).rejects.toMatchObject({ code: "owner_session_required" });
  await expect(authorizeOwnerSession(store, "brain", origin, session.id, session.csrf, new Date(now.getTime() + 31 * 60000))).rejects.toThrow();
  await revokeOwnerSession(store, "brain", session.id);
  await expect(authorizeOwnerSession(store, "brain", origin, session.id, session.csrf, now)).rejects.toThrow();
  const legacy = await new DurableControlPlane(store).createWebSession({ scope: "admin", principal: "mcp", tenantId: "local" }, "owner-browser");
  await expect(authorizeOwnerSession(store, "brain", origin, legacy.id, legacy.csrfToken)).rejects.toThrow();
 } finally { await store.close(); }
});
test("service-owned browser rejects forged access, executes canonical memory flows, and rechecks revocation", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-owner-ui-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
 try {
  execFileSync("git", ["-C", service.engine.repository.root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", service.engine.repository.root, "config", "user.email", "test@example.invalid"]);
  await expect(callLocalService(config, "ui.open", {}, { context: { scope: "read" } })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(callLocalService(config, "ui.open", {}, { context: { scope: "admin", allowedAccessLabels: [] } })).rejects.toMatchObject({ code: "owner_access_required" });
  const configPath = join(root, "config.json"); await writeFile(configPath, JSON.stringify({ stateRoot: config.stateRoot }));
  const cli = Bun.spawn([process.execPath, "src/cli.ts", "ui", "status", "--config", configPath, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [cliOutput, cliError, cliCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  expect(cliCode).toBe(0); expect(cliError).toBe(""); expect(cliOutput).toContain('"running": false');
  const starts = await Promise.all([callLocalService(config, "ui.start"), callLocalService(config, "ui.start")]) as Array<{ origin: string }>;
  expect(starts[0]!.origin).toBe(starts[1]!.origin);
  const login = await callLocalService(config, "ui.open") as { url: string };
  const url = new URL(login.url), origin = url.origin, ticket = new URLSearchParams(url.hash.slice(1)).get("ticket")!;
  const page = await fetch(origin);
  expect(await page.text()).toContain("Pinned questions");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("cache-control")).toBe("no-store");
  let cookie = "", csrf = "";
  const post = async (path: string, input: unknown, headers: Record<string, string> = {}) => {
   const response = await fetch(origin + "/api/" + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-Manas-Csrf": csrf, ...headers }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
   return { response, value: await response.json() as any };
  };
  expect((await post("status", {})).response.status).toBe(401);
  expect((await post("login", { ticket }, { Origin: "https://evil.invalid" })).response.status).toBe(400);
  const signedIn = await post("login", { ticket });
  cookie = signedIn.response.headers.get("set-cookie")!.split(";")[0]!;
  csrf = signedIn.value.data.csrf;
  expect(signedIn.response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect((await post("login", { ticket })).response.status).toBe(401);
  expect((await post("status", {}, { "X-Manas-Csrf": "bad" })).response.status).toBe(401);
  expect((await post("status", {}, { Origin: "" })).response.status).toBe(400);
  expect((await post("status", {}, { Host: "evil.invalid" })).response.status).toBe(400);
  expect((await post("operation", { operation: "auth.session.create", input: { userId: "owner-browser" } })).value.error.code).toBe("operation_not_allowed");
  const assertion = "<img src=x onerror=alert(1)> Juniper owner is Maya.";
  const write = await post("operation", { operation: "memory.remember", input: { text: assertion, idempotencyKey: "ui-memory", provenance: { sourceType: "user" }, visibility: ["private"] } });
  expect(write.value.ok).toBe(true);
  const memory = write.value.data;
  expect((await post("operation", { operation: "memory.recall", input: { query: "Juniper" } })).value.data.results[0].text).toBe(assertion);
  expect((await post("operation", { operation: "memory.forget", input: { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "ui-withdraw" } })).value.ok).toBe(true);
  expect((await post("operation", { operation: "memory.recall", input: { query: "Juniper" } })).value.data.results).toEqual([]);
  expect((await post("operation", { operation: "memory.history", input: { id: memory.id } })).value.data.history).toHaveLength(2);
  expect((await post("status", { text: "x".repeat(262144) })).response.status).toBe(413);
  const definition = service.engine.operations.get("retrieval.search"), previous = definition.execute;
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
  definition.execute = async () => { started(); await waiting; return { secret: "do not disclose after logout" }; };
  const pending = post("operation", { operation: "retrieval.search", input: { query: "Juniper" } });
  await entered;
  expect((await post("logout", {})).value.ok).toBe(true);
  release();
  const revoked = await pending;
  expect(revoked.response.status).toBe(401);
  expect(JSON.stringify(revoked.value)).not.toContain("do not disclose");
  definition.execute = previous;
  expect((await post("status", {})).response.status).toBe(401);
  await callLocalService(config, "ui.stop");
  expect(await callLocalService(config, "ui.status")).toMatchObject({ running: false });
 } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);

test("stopping the owner UI drains an interrupted request without stalling the service", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-ui-stop-")), config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
 const clients: Array<{ destroy(): void }> = [];
 try {
  const { origin } = await callLocalService(config, "ui.start") as { origin: string };
  const connection = request(origin + "/api/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" } });
  clients.push(connection);
  connection.on("error", () => {});
  const connected = new Promise<void>((resolve) => connection.once("socket", (socket) => socket.connecting ? socket.once("connect", resolve) : resolve()));
  connection.write("{"); await connected;
  const { connect } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
   const raw = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) }, () => {
    raw.write("POST /api/login HTTP/1.1\r\nHost: " + new URL(origin).host + "\r\n"); resolve();
   });
   clients.push(raw); raw.on("error", reject);
  });
  const before = Date.now();
  expect(await callLocalService(config, "ui.stop", {}, { timeoutMs: 2000 })).toEqual({ running: false });
  expect(Date.now() - before).toBeLessThan(2000);
  connection.destroy();
  expect(await callLocalService(config, "service.status")).toMatchObject({ running: true });
 } finally { for (const client of clients) client.destroy(); await service.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
