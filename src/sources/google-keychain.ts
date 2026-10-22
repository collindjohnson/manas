import { createHash, randomBytes } from "node:crypto";
import { validateGoogleCredential, type GoogleCredential } from "./google-oauth";
import { GoogleApiError } from "./google-api";

type Runner = (input: string) => Promise<{ code: number; stdout: string }>;
const service = "com.manas.google.oauth.v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new GoogleApiError("keychain_unavailable", 401, false); }
async function security(input: string) {
 if (process.platform !== "darwin") throw new GoogleApiError("macos_required", 0, false);
 const child = Bun.spawn(["/usr/bin/security", "-i"], { stdin: new Blob([input]), stdout: "pipe", stderr: "ignore" });
 const timer = setTimeout(() => child.kill(), 30000);
 const reader = child.stdout.getReader(), chunks: Uint8Array[] = [];
 let size = 0;
 try {
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8192) { child.kill(); invalid(); } chunks.push(part.value); }
  return { code: await child.exited, stdout: Buffer.concat(chunks).toString("utf8").trim() };
 } catch { child.kill(); invalid(); } finally { clearTimeout(timer); reader.releaseLock(); }
}
type Manifest = { version: 1; generation: string; count: number; hash: string };
/** Call under the runtime's exclusive owner lock. No secret enters argv, Git, or operational SQL. */
export class MacGoogleCredentialStore {
 private pending = Promise.resolve();
 constructor(private readonly run: Runner = security) {}
 private key(accountId: string) { if (!/^[a-f0-9]{64}$/.test(accountId)) invalid(); return accountId; }
 private async serial<T>(action: () => Promise<T>) {
  const previous = this.pending;
  let release!: () => void;
  this.pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
 }
 private async read(account: string, allowMissing = false) {
  const result = await this.run("find-generic-password -s " + service + " -a " + account + " -w\n");
  if (result.code === 44 && allowMissing) throw new GoogleApiError("credential_not_found", 401, false);
  if (result.code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout.trim()) || result.stdout.trim().length > 2048) invalid();
  return result.stdout.trim();
 }
 private async write(account: string, value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 2048) invalid();
  const result = await this.run("add-generic-password -U -s " + service + " -a " + account + " -w " + value + "\nfind-generic-password -s " + service + " -a " + account + " -w\n");
  if (result.code !== 0 || result.stdout.trim() !== value) invalid();
 }
 private async manifest(accountId: string, allowMissing = false) {
  let value: Manifest;
  try { value = JSON.parse(Buffer.from(await this.read(accountId, allowMissing), "base64").toString("utf8")); } catch (error) { if (error instanceof GoogleApiError && error.code === "credential_not_found") throw error; invalid(); }
  if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.generation) || !Number.isInteger(value.count) || value.count < 1 || value.count > 64 || !/^[a-f0-9]{64}$/.test(value.hash)) invalid();
  return value;
 }
 private async publish(accountId: string, encoded: string) {
  if (encoded.length > 64 * 2048) throw new GoogleApiError("credentials_too_large", 0, false);
  const previous = await this.manifest(accountId).catch(() => undefined);
  const generation = randomBytes(16).toString("hex"), chunks = encoded.match(/.{1,2048}/g)!;
  for (let index = 0; index < chunks.length; index++) await this.write(accountId + "." + generation + "." + index, chunks[index]!);
  const manifest: Manifest = { version: 1, generation, count: chunks.length, hash: hash(encoded) };
  await this.write(accountId, Buffer.from(JSON.stringify(manifest)).toString("base64"));
  if (previous) for (let index = 0; index < previous.count; index++) await this.run("delete-generic-password -s " + service + " -a " + accountId + "." + previous.generation + "." + index + "\n").catch(() => {});
 }
 private async load(accountId: string): Promise<GoogleCredential> {
  const manifest = await this.manifest(accountId, true);
  let encoded = "";
  for (let index = 0; index < manifest.count; index++) encoded += await this.read(accountId + "." + manifest.generation + "." + index);
  if (hash(encoded) !== manifest.hash) invalid();
  let credential: GoogleCredential;
  try { credential = validateGoogleCredential(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))); } catch { invalid(); }
  if (credential.accountId !== accountId) invalid();
  return credential;
 }
 async put(credential: GoogleCredential): Promise<void> {
  validateGoogleCredential(credential);
  const accountId = this.key(credential.accountId), encoded = Buffer.from(JSON.stringify(credential)).toString("base64");
  return this.serial(() => this.publish(accountId, encoded)).catch(() => invalid());
 }
 async get(accountId: string): Promise<GoogleCredential> {
  this.key(accountId);
  return this.serial(() => this.load(accountId)).catch((error) => { if (error instanceof GoogleApiError && error.code === "credential_not_found") throw error; invalid(); });
 }
 async replace(expected: GoogleCredential, replacement: GoogleCredential): Promise<void> {
  validateGoogleCredential(expected); validateGoogleCredential(replacement);
  const accountId = this.key(expected.accountId);
  if (replacement.accountId !== accountId || replacement.email.toLowerCase() !== expected.email.toLowerCase()) invalid();
  const frozen = structuredClone(expected), encoded = Buffer.from(JSON.stringify(replacement)).toString("base64");
  return this.serial(async () => {
   const current = await this.load(accountId);
   for (const key of ["accessToken", "refreshToken", "clientId", "clientSecret", "expiresAt", "email"] as const) if (current[key] !== frozen[key]) invalid();
   if (JSON.stringify([...current.scopes].sort()) !== JSON.stringify([...frozen.scopes].sort())) invalid();
   await this.publish(accountId, encoded);
  }).catch(() => invalid());
 }
 async remove(accountId: string): Promise<void> {
  this.key(accountId);
  return this.serial(async () => {
   const manifest = await this.manifest(accountId);
   // Revoke the pointer first. Interrupted cleanup cannot expose a partial credential.
   const removed = await this.run("delete-generic-password -s " + service + " -a " + accountId + "\n");
   if (removed.code !== 0) invalid();
   for (let index = 0; index < manifest.count; index++) await this.run("delete-generic-password -s " + service + " -a " + accountId + "." + manifest.generation + "." + index + "\n").catch(() => {});
  }).catch(() => invalid());
 }
}
