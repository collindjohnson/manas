import { createHash, randomBytes } from "node:crypto";
import type { BrainStore } from "./store";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class OwnerSessionError extends Error {
 readonly code = "owner_session_required"; readonly retryable = false;
 readonly suggestedFix = "Run manas ui open to obtain a fresh owner login link.";
 constructor() { super("A current owner browser session is required."); }
}
export async function createOwnerSession(store: BrainStore, brainId: string, origin: string, now = new Date()) {
 if (!brainId || !/^https?:\/\//.test(origin)) throw new OwnerSessionError();
 const id = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
 const absoluteExpiresAt = new Date(now.getTime() + 8 * 3600000).toISOString();
 await store.query("INSERT INTO brain_owner_sessions(session_hash,tenant_id,brain_id,origin,csrf_hash,idle_expires_at,absolute_expires_at) VALUES($1,'local',$2,$3,$4,$5,$6)", [hash(id), brainId, origin, hash(csrf), new Date(now.getTime() + 30 * 60000).toISOString(), absoluteExpiresAt]);
 return { id, csrf, absoluteExpiresAt };
}
export async function authorizeOwnerSession(store: BrainStore, brainId: string, origin: string, id: string, csrf: string, now = new Date()) {
 if (!/^[\w-]{43}$/.test(id) || !/^[\w-]{43}$/.test(csrf)) throw new OwnerSessionError();
 const rows = await store.query("UPDATE brain_owner_sessions SET last_seen_at=$5,idle_expires_at=LEAST($6::timestamptz,absolute_expires_at) WHERE session_hash=$1 AND tenant_id='local' AND brain_id=$2 AND origin=$3 AND csrf_hash=$4 AND revoked_at IS NULL AND idle_expires_at>$5 AND absolute_expires_at>$5 RETURNING session_hash", [hash(id), brainId, origin, hash(csrf), now.toISOString(), new Date(now.getTime() + 30 * 60000).toISOString()]);
 if (!rows.length) throw new OwnerSessionError();
}
export async function revokeOwnerSession(store: BrainStore, brainId: string, id: string) {
 await store.query("UPDATE brain_owner_sessions SET revoked_at=now() WHERE session_hash=$1 AND tenant_id='local' AND brain_id=$2", [hash(id), brainId]);
}
