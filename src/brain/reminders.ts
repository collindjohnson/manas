import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrainRepository } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import { getOpenLoop, listOpenLoops } from "./open-loops";
import { scopedSnapshot } from "./evidence-contract";
import { enqueueJob, updateJobProgress, type BrainJob } from "./jobs";
type Delivery = { version: 1; brainId: string; loopId: string; revision: string; dueAt: string; jobId?: string; phase: "queued" | "dispatching" | "delivered" | "uncertain" | "suppressed"; reason?: string };
const ACTION = "open-loop-reminder";
const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as Delivery;
export class ReminderError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string, readonly suggestedFix = "Review the current loop and reminder receipt in the owner interface.") { super(message); }
}
function owner(context: OperationContext) {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined) throw new ReminderError("owner_access_required", "Local notification delivery requires owner administration.");
}
export async function enqueueReminder(repository: BrainRepository, store: BrainStore, context: OperationContext, input: { id: string; expectedRevision: string }) {
 owner(context);
 const snapshot = await scopedSnapshot(repository, context), loop = await getOpenLoop(repository, context, input.id);
 if (loop.revision !== input.expectedRevision) throw new ReminderError("revision_conflict", "The loop changed.");
 if (loop.status !== "open" || !loop.dueAt) throw new ReminderError("reminder_not_dueable", "A reminder requires an open loop with a due timestamp.");
 const id = "reminder:" + createHash("sha256").update(JSON.stringify([snapshot.brainId, loop.id, loop.revision, loop.dueAt])).digest("hex");
 return store.transaction(async (transaction) => {
  const previous = (await transaction.query<{ result: unknown }>("SELECT result FROM brain_admin_action_receipts WHERE tenant_id='local' AND idempotency_key=$1 FOR UPDATE", [id]))[0];
  if (previous) { const delivery = parse(previous.result); return { id, ...delivery, replayed: true }; }
  const delivery: Delivery = { version: 1, brainId: snapshot.brainId, loopId: loop.id, revision: loop.revision, dueAt: loop.dueAt!, phase: "queued" };
  const inserted = await transaction.query("INSERT INTO brain_admin_action_receipts (id,tenant_id,action,target_id,principal,idempotency_key,status,result) VALUES ($1,'local',$2,$3,$4,$1,'running',$5::jsonb) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id", [id, ACTION, loop.id, context.principal ?? "owner", JSON.stringify(delivery)]);
  if (!inserted.length) throw new ReminderError("reminder_concurrent_write", "A reminder is being queued; retry to read its receipt.");
  const job = await enqueueJob(transaction, { type: "reminder-delivery", payload: { brainId: snapshot.brainId, deliveryId: id }, availableAt: new Date(loop.dueAt!), idempotencyKey: id, maxAttempts: 3 });
  delivery.jobId = job.id;
  await transaction.query("UPDATE brain_admin_action_receipts SET result=$2::jsonb WHERE id=$1 AND tenant_id='local'", [id, JSON.stringify(delivery)]);
  return { id, ...delivery, replayed: false };
 });
}
export async function listReminders(repository: BrainRepository, store: BrainStore, context: OperationContext, input: { limit?: number; after?: string } = {}) {
 const snapshot = await scopedSnapshot(repository, context);
 const loops = await listOpenLoops(repository, context, { status: "open", limit: input.limit, after: input.after });
 const items = [];
 for (const loop of loops.items) {
  if (!("title" in loop) || !loop.dueAt || Date.parse(loop.dueAt) > Date.now()) continue;
  const rows = await store.query<{ id: string; result: unknown }>("SELECT id,result FROM brain_admin_action_receipts WHERE tenant_id='local' AND action=$1 AND target_id=$2 AND result->>'brainId'=$3 ORDER BY created_at DESC LIMIT 20", [ACTION, loop.id, snapshot.brainId]);
  const current = rows.map((row) => ({ id: row.id, ...parse(row.result) })).find((delivery) => delivery.revision === loop.revision);
  items.push({ ...loop, notification: current ? { id: current.id, phase: current.phase, reason: current.reason ?? null } : { phase: "not_requested" } });
 }
 return { items, next: loops.next };
}
export async function sendLocalReminder() {
 if (process.platform !== "darwin") throw new ReminderError("macos_notification_required", "Local reminders require macOS.");
 // Static text keeps source content out of Notification Center and shell interpolation.
 await promisify(execFile)("/usr/bin/osascript", ["-e", 'display notification "A commitment is due. Open Manas to review it." with title "Manas"'], { timeout: 5000 });
}
export function reminderDeliveryHandler(dependencies: { repository: BrainRepository; store: BrainStore; workerId: string; notify?: () => Promise<void> }) {
 return async (job: BrainJob) => {
  const payload = job.payload as { brainId: string; deliveryId: string };
  const context: OperationContext = { scope: "admin", tenantId: job.tenantId, brainId: payload.brainId, principal: "reminder-worker" };
  await scopedSnapshot(dependencies.repository, context);
  const check = async () => {
   const rows = await dependencies.store.query("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND worker_id=$3 AND attempts=$4 AND lease_expires_at>now() RETURNING id", [job.id, job.tenantId, dependencies.workerId, job.attempts]);
   if (!rows.length) throw new ReminderError("reminder_cancelled", "Reminder was cancelled or its worker lease was lost.");
  };
  await check();
  const row = (await dependencies.store.query<{ result: unknown }>("SELECT result FROM brain_admin_action_receipts WHERE id=$1 AND tenant_id=$2 AND action=$3", [payload.deliveryId, job.tenantId, ACTION]))[0];
  if (!row) throw new ReminderError("reminder_intent_required", "Reminder delivery has no persisted owner intent.");
  const delivery = parse(row.result);
  if (delivery.brainId !== payload.brainId || delivery.jobId !== job.id) throw new ReminderError("reminder_intent_required", "Reminder intent does not match this job.");
  const save = async (phase: Delivery["phase"], reason?: string) => {
   delivery.phase = phase; if (reason) delivery.reason = reason;
   await dependencies.store.query("UPDATE brain_admin_action_receipts SET status='complete',result=$3::jsonb,completed_at=now() WHERE id=$1 AND tenant_id=$2", [payload.deliveryId, job.tenantId, JSON.stringify(delivery)]);
  };
  // An OS notification and its receipt cannot be committed atomically.
  if (delivery.phase === "dispatching") { await save("uncertain", "dispatch_interrupted"); return; }
  if (delivery.phase !== "queued") return;
  try {
   const loop = await getOpenLoop(dependencies.repository, context, delivery.loopId);
   if (loop.revision !== delivery.revision || loop.status !== "open" || loop.dueAt !== delivery.dueAt) { await save("suppressed", "loop_changed"); return; }
   if (Date.parse(delivery.dueAt) > Date.now()) throw new ReminderError("reminder_not_due", "Reminder is not due.");
  } catch (error) {
   if (error instanceof ReminderError) throw error;
   await save("suppressed", "evidence_unavailable"); return;
  }
  await check();
  // Atomic phase reservation prevents concurrent deliveries even if two clients race.
  const reserved = await dependencies.store.query("UPDATE brain_admin_action_receipts SET result=jsonb_set(result,'{phase}','\"dispatching\"'::jsonb) WHERE id=$1 AND tenant_id=$2 AND result->>'phase'='queued' RETURNING id", [payload.deliveryId, job.tenantId]);
  if (!reserved.length) return;
  try {
   await check();
   await (dependencies.notify ?? sendLocalReminder)();
   await save("delivered");
  } catch { await save("uncertain", "notification_outcome_unknown"); }
  await check();
  await updateJobProgress(dependencies.store, job.id, dependencies.workerId, { deliveryId: payload.deliveryId, phase: delivery.phase }, job.tenantId);
 };
}
