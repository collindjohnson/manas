import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPgliteBrainStore } from "../src/brain/store";
import { DurableOAuthAuthorizationServer } from "../src/brain/oauth-persistence";
import type { OAuthTokenResponse } from "../src/brain/oauth";

describe("durable OAuth persistence", () => {
	test("survives a store reopen and rotates refresh tokens with scope narrowing", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-oauth-persistent-"));
		const verifier = "verifier-012345678901234567890123456789012345678901234567890123456789";
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		try {
			const firstStore = await openPgliteBrainStore(join(root, "db"));
			const first = new DurableOAuthAuthorizationServer(firstStore, () => new Date("2026-01-01T00:00:00.000Z"));
			await first.registerClient({ id: "client", redirectUris: ["http://127.0.0.1/callback"], allowedScopes: ["read", "write"], confidential: false });
			const authorization = await first.authorize({ clientId: "client", redirectUri: "http://127.0.0.1/callback", codeChallenge: challenge, codeChallengeMethod: "S256", scope: ["read", "write"], subject: "user", tenantId: "tenant", brainIds: ["brain"] });
			const issued = await first.redeemCode({ clientId: "client", code: authorization.code, redirectUri: authorization.redirectUri, codeVerifier: verifier });
			expect(await first.introspect(issued.accessToken)).toMatchObject({ active: true, tenantId: "tenant", scope: ["read", "write"] });
			const racedAuthorization = await first.authorize({ clientId: "client", redirectUri: "http://127.0.0.1/callback", codeChallenge: challenge, codeChallengeMethod: "S256", scope: ["read"], subject: "user", tenantId: "tenant", brainIds: ["brain"] });
			const codeRaces = await Promise.allSettled([
				first.redeemCode({ clientId: "client", code: racedAuthorization.code, redirectUri: racedAuthorization.redirectUri, codeVerifier: verifier }),
				first.redeemCode({ clientId: "client", code: racedAuthorization.code, redirectUri: racedAuthorization.redirectUri, codeVerifier: verifier }),
			]);
			expect(codeRaces.filter((race) => race.status === "fulfilled")).toHaveLength(1);
			const racedIssued = codeRaces.find((race): race is PromiseFulfilledResult<OAuthTokenResponse> => race.status === "fulfilled")!.value;
			const refreshRaces = await Promise.allSettled([first.refresh(racedIssued.refreshToken), first.refresh(racedIssued.refreshToken)]);
			expect(refreshRaces.filter((race) => race.status === "fulfilled")).toHaveLength(1);
			await firstStore.close();
			const secondStore = await openPgliteBrainStore(join(root, "db"));
			try {
				const second = new DurableOAuthAuthorizationServer(secondStore, () => new Date("2026-01-01T00:00:00.000Z"));
				const rotated = await second.refresh(issued.refreshToken, ["read"]);
				expect(rotated.scope).toEqual(["read"]);
				expect(await second.introspect(issued.accessToken)).toMatchObject({ active: true });
				await expect(second.refresh(issued.refreshToken)).rejects.toThrow("refresh token");
				await second.revoke(rotated.accessToken);
				expect(await second.introspect(rotated.accessToken)).toEqual({ active: false });
			} finally { await secondStore.close(); }
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
