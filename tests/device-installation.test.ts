import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceInstallation, resolveTailscaleExecutable, type TailscaleRunner } from "../src/device-installation";

async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "manas-device-install-"));
 const hostname = "brain.example.ts.net";
 let config: Record<string, any> = { TCP: { "443": { HTTPS: true } }, Web: { [hostname + ":443"]: { Handlers: { "/other": { Proxy: "http://127.0.0.1:9000" } } } }, Services: { "svc:other": { TCP: { "8443": { HTTPS: true } } } } };
 const original = structuredClone(config);
 const calls: string[][] = [];
 let failAfterWrite = false;
 const runner: TailscaleRunner = async (args) => {
  calls.push(args);
  if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: hostname + ".", ID: "self", HostName: "brain", Online: true }, Peer: { key: { ID: "selected", HostName: "laptop", Online: true } } });
  if (args.join(" ") === "serve status --json") return JSON.stringify(config);
  const port = args.find((arg) => arg.startsWith("--https="))!.slice(8);
  const hp = hostname + ":" + port;
  if (args.at(-1) === "off") { delete config.TCP[port]; delete config.Web[hp]; if (config.AllowFunnel) { delete config.AllowFunnel[hp]; if (!Object.keys(config.AllowFunnel).length) delete config.AllowFunnel; } }
  else {
   config.TCP ??= {}; config.Web ??= {};
   config.TCP[port] = { HTTPS: true };
   config.Web[hp] = { Handlers: { "/manas": { Proxy: args.at(-1) } } };
   if (args[0] === "funnel") { config.AllowFunnel ??= {}; config.AllowFunnel[hp] = true; }
   else if (config.AllowFunnel) delete config.AllowFunnel[hp];
  }
  if (failAfterWrite) { failAfterWrite = false; throw new Error("simulated crash after command"); }
  return "";
 };
 const installation = new DeviceInstallation(root, "brain-id", runner);
 return { root, installation, original, calls, configuration: () => config, setConfiguration: (value: Record<string, any>) => { config = value; }, fail: () => { failAfterWrite = true; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("device installation previews, owns only its listener, and preserves unrelated services", async () => {
 const f = await fixture();
 try {
  const preview = await f.installation.preview({ deviceIds: ["selected"] });
  expect(preview.conflict).toBe(false);
  expect(preview.receipt.visibility).toEqual([]);
  expect(preview.receipt.write).toBe(false);
  expect(f.calls.every((args) => args.includes("--json"))).toBe(true);
  let gatewayStarted = false;
  const receipt = await f.installation.enable({ deviceIds: ["selected"] }, async () => { expect(JSON.parse(await readFile(f.installation.paths.receipt, "utf8")).phase).toBe("installing"); gatewayStarted = true; });
  expect(gatewayStarted).toBe(true);
  expect(receipt.phase).toBe("active");
  expect((await f.installation.status()).owned).toBe(true);
  expect((await f.installation.disable(true)).installed).toBe(true);
  await f.installation.disable();
  expect(f.configuration()).toEqual(f.original);
  expect((await f.installation.receipt())!.phase).toBe("disabled");
  expect(f.calls.some((args) => args.includes("reset") || args.includes("set-config"))).toBe(false);
 } finally { await f.cleanup(); }
});
test("interrupted installation resumes from durable intent without adopting unowned listeners", async () => {
 const f = await fixture();
 try {
  f.fail();
  await expect(f.installation.enable({ deviceIds: ["selected"] }, async () => {})).rejects.toThrow("simulated crash");
  expect((await f.installation.receipt())!.phase).toBe("installing");
  const restarted = new DeviceInstallation(f.root, "brain-id", f.installation.runner);
  expect((await restarted.enable({ deviceIds: ["selected"] }, async () => {})).phase).toBe("active");
  await restarted.disable();
  const config = f.configuration(); config.TCP["8443"] = { HTTPS: true };
  const before = structuredClone(config);
  await expect(restarted.enable({ deviceIds: ["selected"] }, async () => { throw new Error("must not start"); })).rejects.toMatchObject({ code: "device_configuration_conflict" });
  expect(f.configuration()).toEqual(before);
 } finally { await f.cleanup(); }
});
test("edited listener removal revokes access while preserving edits and requires explicit Funnel", async () => {
 const f = await fixture();
 try {
  await f.installation.enable({ deviceIds: ["selected"] }, async () => {});
  expect((await f.installation.preview({ deviceIds: ["selected"], publicFunnel: true })).conflict).toBe(true);
  f.configuration().Web["brain.example.ts.net:8443"].Handlers["/other"] = { Text: "preserve" };
  const edited = structuredClone(f.configuration());
  await expect(f.installation.disable()).rejects.toMatchObject({ code: "device_configuration_conflict" });
  expect(f.configuration()).toEqual(edited);
  expect((await f.installation.receipt())!.phase).toBe("disabled");
  f.setConfiguration(structuredClone(f.original));
  await f.installation.enable({ deviceIds: [], publicFunnel: true }, async () => {});
  expect(f.configuration().AllowFunnel["brain.example.ts.net:8443"]).toBe(true);
  await f.installation.disable();
  expect(f.configuration()).toEqual(f.original);
 } finally { await f.cleanup(); }
});
test("foreground collisions, unknown devices, and invalid settings fail without mutation", async () => {
 const f = await fixture();
 try {
  f.configuration().Foreground = { session: { TCP: { "8443": { HTTPS: true } } } };
  expect((await f.installation.preview({ deviceIds: ["selected"] })).conflict).toBe(true);
  await expect(f.installation.preview({ deviceIds: ["absent"] })).rejects.toMatchObject({ code: "unknown_device" });
  await expect(f.installation.preview({ deviceIds: [] })).rejects.toMatchObject({ code: "invalid_device_settings" });
  await expect(f.installation.preview({ deviceIds: [], publicFunnel: true, httpsPort: 1234 })).rejects.toMatchObject({ code: "invalid_device_settings" });
  expect(f.calls.every((args) => args.includes("--json"))).toBe(true);
 } finally { await f.cleanup(); }
});
test("receipt mismatch and corrupt ownership state fail closed", async () => {
 const f = await fixture();
 try {
  await f.installation.enable({ deviceIds: ["selected"] }, async () => {});
  const other = new DeviceInstallation(f.root, "another-brain", f.installation.runner);
  await expect(other.receipt()).rejects.toMatchObject({ code: "invalid_device_receipt" });
  await writeFile(f.installation.paths.receipt, "{}", { mode: 0o600 });
  await expect(f.installation.receipt()).rejects.toThrow();
 } finally { await f.cleanup(); }
});

test("service locates an executable without relying on an interactive shell PATH", async () => {
 expect(await resolveTailscaleExecutable(["relative", "/missing/manas-test-executable", process.execPath])).toBe(process.execPath);
 await expect(resolveTailscaleExecutable(["relative", "/missing/manas-test-executable"])).rejects.toMatchObject({ code: "tailscale_unavailable" });
});
