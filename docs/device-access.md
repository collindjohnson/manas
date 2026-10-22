# Optional device access

Device access is off until the owner explicitly enables it. The running macOS service exposes a restricted MCP endpoint through Tailscale Serve. It uses the same engine, Git brain, PGLite store, providers, operation catalog, and citation checks as local clients. Browser administration remains local.

Start the configured service, then inspect devices and preview the installation:

```sh
manas devices peers --config /absolute/config.json
manas devices preview --config /absolute/config.json --input '{"deviceIds":["stable-device-id"],"visibility":[],"write":false}'
manas devices enable --config /absolute/config.json --input '{"deviceIds":["stable-device-id"],"visibility":[],"write":false}'
manas devices status --config /absolute/config.json
```

Use the stable IDs returned by `peers`, including for tagged devices. The default HTTPS port is 8443; set `httpsPort` to choose another unused port. Preview reports the URL, exact command, proposed settings, and ownership conflicts without changing Tailscale or creating ownership files. Installation requires a connected Tailscale installation with Serve/HTTPS permitted by the tailnet policy. Tailscale commands have a ten-second deadline; a command failure reports an actionable error and disables the gateway.

Configure the remote MCP client with the returned `https://<node>.<tailnet>.ts.net:8443/manas` URL and a personal access token created using the owner administration flow. Treat the token as a credential. It needs `read`; authorized mutations additionally require `write` or `admin` on the token and explicit `write:true` on the device installation. Owner administration operations are excluded even for an admin token. Generic MCP clients remain supported.

`visibility:[]` permits ordinary public evidence only. Explicit labels are the maximum grant shared by the selected devices. For a token associated with a user, this grant is intersected with that user's current tenant and brain permissions. Tokens for another tenant are rejected. The gateway never accepts caller-supplied tenant, brain, or label escalation. Changes to token validity and membership are checked again before returning an operation result. Remote capture uses the same revision and idempotency rules as local memory operations; repeated delivery returns a replay receipt for the same memory.

The service creates an owner-only Unix socket directory instead of forwarding a TCP port. The gateway trusts proxy metadata only through this private socket, requires HTTPS forwarding metadata for its exact public hostname, and resolves the source IP with Tailscale `whois` for every private request. It compares the authorized machine's stable ID with the explicit allowlist. A shared Tailscale user identity does not grant every device access. Identity lookup failures, malformed forwarded headers, and unselected devices fail closed. Request and response checks prevent delivery after device authorization changes. Client requests are bounded in size and rate; browser origins are rejected.

The service reserves the entire selected listener port and records its exact proxy configuration in an owner-only, durable receipt under `stateRoot/device-access/state.json`. It saves installation intent before the Tailscale command so a crash after configuration can resume. It rechecks the configuration before changes and verifies ownership and unrelated configuration afterward. It never runs `serve reset` or replaces the whole Serve configuration. Other ports, services, and foreground sessions are preserved. Configuration commands are serialized within Manas; do not concurrently edit the same listener from another Tailscale administration process. An unexpected change disables the gateway and requires owner review instead of restoring an older global configuration.

```sh
manas devices disable --preview --config /absolute/config.json
manas devices disable --config /absolute/config.json
```

Removal revokes the in-memory grant first and removes only the exact owned listener. Edited listeners are preserved and reported as conflicts; Manas access stays disabled. Stop and disable the previous installation before changing its hostname, port, or private/public exposure. Changing selected devices, labels, or write permission on the same endpoint is supported with another `enable` call. Service shutdown stops and drains the gateway. Startup resumes a saved installation only when its owned configuration can be verified; device failures do not prevent local service startup. `status` distinguishes saved installation, configuration ownership, running gateway, and a structured failure. These states do not prove that another device has connected successfully.

Public Funnel exposure is a separate explicit choice:

```sh
manas devices preview --config /absolute/config.json --input '{"deviceIds":[],"publicFunnel":true,"httpsPort":8443,"visibility":[],"write":false}'
```

Only a subsequent `enable` with `publicFunnel:true` publishes that endpoint. Public requests cannot be restricted by Tailscale device identity; they still require a valid personal access token and the configured scope and visibility grant. Funnel is never implicitly enabled by a private installation. The dedicated port avoids converting unrelated handlers to public exposure. Supported Funnel ports are 443, 8443, and 10000, subject to tailnet policy. Review [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) and [Funnel](https://tailscale.com/docs/features/tailscale-funnel) setup requirements.

Runtime backups intentionally exclude this machine-specific installation receipt and Tailscale credentials/configuration. A clean restore starts with device access disabled; reconnect Tailscale, select devices, issue new client tokens, and preview before enabling it. Existing installations on another machine are not removed by restoring a brain.

Verification uses a real service, private socket, CLI, Git brain, and PGLite store with injected Tailscale status/configuration/identity responses. It covers visibility intersection, token revocation during a request, authorized idempotent capture, restart recovery, edited listener refusal, explicit public exposure, and preservation of unrelated configuration. The installed Tailscale CLI was inspected for Unix proxy support; an actual Serve/Funnel listener and connection from a selected second device have not been activated or verified by these tests.
