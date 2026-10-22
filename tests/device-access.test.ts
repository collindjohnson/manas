import { expect, test } from "bun:test";
import { createDeviceRequestAuthorizer, type DeviceAccessGrant } from "../src/device-access";

test("device gateway requires current machine identity and explicit public exposure", async () => {
 let grant: DeviceAccessGrant = { enabled: true, hostname: "brain.example.ts.net", httpsPort: 8443, deviceIds: ["selected"], publicFunnel: false };
 let identity = { Node: { StableID: "selected", MachineAuthorized: true } };
 let lookups = 0;
 let duringLookup = () => {};
 const authorize = createDeviceRequestAuthorizer({ grant: () => grant, whois: async () => { lookups++; duringLookup(); return identity; } });
 const request = (headers: Record<string, string> = {}) => new Request("http://localhost/mcp", { headers: { "x-forwarded-host": "brain.example.ts.net:8443", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.1", ...headers } });
 expect(await authorize(request())).toBe(true);
 identity = { Node: { StableID: "other", MachineAuthorized: true } };
 expect(await authorize(request())).toBe(false);
 identity = { Node: { StableID: "selected", MachineAuthorized: false } };
 expect(await authorize(request())).toBe(false);
 identity.Node.MachineAuthorized = true;
 for (const headers of <Record<string, string>[]>[{ "x-forwarded-for": "100.64.0.1, 100.64.0.2" }, { "x-forwarded-host": "attacker.ts.net:8443" }, { "x-forwarded-proto": "http" }, { "tailscale-funnel-request": "?1" }]) expect(await authorize(request(headers))).toBe(false);
 expect(lookups).toBe(3);
 grant = { ...grant, publicFunnel: true };
 expect(await authorize(request({ "tailscale-funnel-request": "?1" }))).toBe(true);
 expect(await authorize(request({ "tailscale-funnel-request": "true" }))).toBe(false);
 duringLookup = () => { grant = { ...grant, deviceIds: [] }; };
 expect(await authorize(request())).toBe(false);
 grant = { ...grant, deviceIds: ["selected"] };
 duringLookup = () => { grant = { ...grant, enabled: false }; };
 expect(await authorize(request())).toBe(false);
});
