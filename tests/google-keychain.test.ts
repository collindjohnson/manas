import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { MacGoogleCredentialStore } from "../src/sources/google-keychain";
import type { GoogleCredential } from "../src/sources/google-oauth";
const credential: GoogleCredential = {
 version: 1, accountId: createHash("sha256").update("google:subject").digest("hex"), subject: "subject", email: "owner@example.invalid",
 clientId: "123-example.apps.googleusercontent.com", clientSecret: "private-desktop-secret", refreshToken: "private-refresh", accessToken: "private-access-" + "x".repeat(7000), expiresAt: Date.now() + 3600000,
 scopes: ["openid", "email", "https://www.googleapis.com/auth/contacts.readonly"],
};
function fakeKeychain() {
 const entries = new Map<string, string>();
 let rejectPointer = false;
 const run = async (input: string) => {
  let stdout = "", code = 0;
  for (const line of input.trim().split("\n")) {
   expect(Buffer.byteLength(line)).toBeLessThan(4096);
   const fields = line.split(" "), account = fields[fields.indexOf("-a") + 1]!;
   expect(fields[fields.indexOf("-s") + 1]).toBe("com.manas.google.oauth.v1");
   expect(account).toMatch(/^[a-f0-9]{64}(\.[a-f0-9]{32}\.\d+)?$/);
   if (fields[0] === "add-generic-password") {
    if (rejectPointer && account === credential.accountId) { code = 1; continue; }
    entries.set(account, fields.at(-1)!);
   } else if (fields[0] === "find-generic-password") {
    stdout = entries.get(account) ?? ""; code = entries.has(account) ? 0 : 44;
   } else if (fields[0] === "delete-generic-password") { code = entries.delete(account) ? 0 : 44; }
   else throw new Error("unexpected command");
  }
  return { code, stdout };
 };
 return { entries, run, failPointer: (value: boolean) => { rejectPointer = value; } };
}
test("Google Keychain storage chunks bounded stdin writes, verifies bytes, and removes the live credential", async () => {
 const fake = fakeKeychain(), store = new MacGoogleCredentialStore(fake.run);
 await store.put(credential);
 expect(fake.entries.size).toBeGreaterThan(2);
 expect(await store.get(credential.accountId)).toEqual(credential);
 await store.put({ ...credential, accessToken: "replacement" });
 expect(fake.entries.size).toBe(2); // Old committed generation is cleaned after pointer publication.
 expect((await store.get(credential.accountId)).accessToken).toBe("replacement");
 await store.remove(credential.accountId);
 expect(fake.entries.size).toBe(0);
 await expect(store.get(credential.accountId)).rejects.toMatchObject({ code: "credential_not_found" });
});
test("Google Keychain failed publication retains the previous complete generation and rejects corruption", async () => {
 const fake = fakeKeychain(), store = new MacGoogleCredentialStore(fake.run);
 await store.put({ ...credential, accessToken: "original" });
 fake.failPointer(true);
 await expect(store.put({ ...credential, accessToken: "replacement" })).rejects.toMatchObject({ code: "keychain_unavailable" });
 expect((await store.get(credential.accountId)).accessToken).toBe("original");
 const manifest = JSON.parse(Buffer.from(fake.entries.get(credential.accountId)!, "base64").toString());
 fake.entries.set(credential.accountId + "." + manifest.generation + ".0", Buffer.from("tampered").toString("base64"));
 await expect(store.get(credential.accountId)).rejects.toMatchObject({ code: "keychain_unavailable" });
 await expect(store.get("x\nmalicious-command")).rejects.toMatchObject({ code: "keychain_unavailable" });
});

test("Google Keychain compare-and-replace cannot overwrite newer consent or revive a disconnected account", async () => {
 const fake = fakeKeychain(), store = new MacGoogleCredentialStore(fake.run);
 const initial = { ...credential, accessToken: "first" };
 await store.put(initial);
 const refreshed = { ...initial, accessToken: "refreshed" };
 await store.replace(initial, refreshed);
 await expect(store.replace(initial, { ...initial, accessToken: "stale-refresh" })).rejects.toMatchObject({ code: "keychain_unavailable" });
 expect((await store.get(credential.accountId)).accessToken).toBe("refreshed");
 await store.remove(credential.accountId);
 await expect(store.replace(refreshed, initial)).rejects.toMatchObject({ code: "keychain_unavailable" });
 expect(fake.entries.has(credential.accountId)).toBe(false);
});
