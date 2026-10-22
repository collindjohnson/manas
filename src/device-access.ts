import { isIP } from "node:net";

export interface DeviceAccessGrant {
 enabled: boolean;
 hostname: string;
 httpsPort: number;
 deviceIds: string[];
 publicFunnel: boolean;
}

export interface TailscaleIdentity {
 Node?: { StableID?: string; MachineAuthorized?: boolean };
}

/** Only use behind a private Unix socket accessible to the owner and Tailscale. */
export function createDeviceRequestAuthorizer(options: {
 grant(): DeviceAccessGrant;
 whois(ip: string): Promise<TailscaleIdentity>;
}): (request: Request) => Promise<boolean> {
 return async (request) => {
  const grant = { ...options.grant() };
  if (!grant.enabled || !/^[a-z0-9.-]+\.ts\.net$/i.test(grant.hostname) || !Number.isInteger(grant.httpsPort) || grant.httpsPort < 1 || grant.httpsPort > 65535) return false;
  const expectedHost = grant.hostname.toLowerCase() + (grant.httpsPort === 443 ? "" : `:${grant.httpsPort}`);
  if (request.headers.get("x-forwarded-host")?.toLowerCase() !== expectedHost || request.headers.get("x-forwarded-proto") !== "https") return false;
  const funnel = request.headers.get("tailscale-funnel-request");
  if (funnel !== null) return funnel === "?1" && grant.publicFunnel;
  const ip = request.headers.get("x-forwarded-for");
  if (!ip || !isIP(ip) || !grant.deviceIds.length) return false;
  try {
   const identity = await options.whois(ip);
   // Re-read after the identity lookup so disabling or changing the grant takes effect immediately.
   const current = options.grant();
   return current.enabled && current.hostname === grant.hostname && current.httpsPort === grant.httpsPort && identity.Node?.MachineAuthorized === true && typeof identity.Node.StableID === "string" && current.deviceIds.includes(identity.Node.StableID);
  } catch { return false; }
 };
}
