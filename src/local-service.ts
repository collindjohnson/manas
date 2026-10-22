import { DeviceAccessController } from "./device-service";
import type { TailscaleRunner } from "./device-installation";
import { startOwnerUi, type OwnerUi } from "./owner-ui";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request, type Server, type IncomingMessage } from "node:http";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config";
import { createBrainEngine, type BrainEngine } from "./engine";
import { acquireStoreOwnership } from "./brain/ownership";
import { authorizePersonalAccessToken, identifyPersonalAccessToken } from "./brain/access-tokens";
import { SqlTenantDirectory } from "./brain/tenancy";
import { OperationRegistry, type OperationContext } from "./brain/operation-registry";

export class LocalServiceError extends Error {
	constructor(readonly code: string, message: string, readonly retryable: boolean, readonly suggestedFix: string) { super(message); }
}
export function localServicePaths(config: Config) {
	const root = join(config.stateRoot, "service");
	const socketRoot = join("/tmp", "manas-" + (process.getuid?.() ?? "local") + "-" + createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16));
	return { root, socket: join(socketRoot, "manas.sock"), token: join(root, "owner.token") };
}
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function ownerToken(path: string): Promise<string> {
	try { await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("local service token must be an owner-only regular file");
	const token = (await readFile(path, "utf8")).trim();
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid local service token");
	return token;
}
function sameToken(left: string, right: string): boolean {
	return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
function structuredError(error: unknown) {
	const value = error as { code?: string; message?: string; retryable?: boolean; suggestedFix?: string };
	return { code: typeof value.code === "string" ? value.code : "operation_failed", message: error instanceof Error ? error.message : "operation failed", retryable: value.retryable === true, suggestedFix: value.suggestedFix ?? "Check the operation input and local service configuration." };
}
const maximumRequestBytes = 8_388_608;
function readOperationBody(req: IncomingMessage): Promise<string> {
 return new Promise((resolve, reject) => {
  let bytes = 0, settled = false;
  const chunks: Buffer[] = [];
  // Continue draining after rejecting an oversized body. Throwing from a
  // Readable async iterator destroys the request before the error can flush.
  req.on("data", (chunk: Buffer) => {
   if (settled) return;
   bytes += chunk.length;
   if (bytes > maximumRequestBytes) {
    settled = true; chunks.length = 0;
    reject(new LocalServiceError("request_too_large", "local service input exceeds 8 MiB", false, "Send a smaller operation input."));
   } else chunks.push(Buffer.from(chunk));
  });
  req.once("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
  req.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
  req.once("aborted", () => { if (!settled) { settled = true; reject(new LocalServiceError("request_aborted", "Local service request was interrupted.", true, "Retry the operation with its idempotency key.")); } });
 });
}
export interface LocalService {
	engine: BrainEngine;
	close(): Promise<void>;
}
export async function startLocalService(options: { config: Config; repositoryRoot: string; storePath: string; worker?: boolean; tailscaleRunner?: TailscaleRunner; onWorkerError?: (error: unknown) => void; onStop?: () => void }): Promise<LocalService> {
	const paths = localServicePaths(options.config);
	await mkdir(paths.root, { recursive: true, mode: 0o700 });
	await chmod(paths.root, 0o700);
	const socketRoot = dirname(paths.socket);
	await mkdir(socketRoot, { recursive: true, mode: 0o700 });
	const socketInfo = await lstat(socketRoot);
	if (!socketInfo.isDirectory() || socketInfo.isSymbolicLink() || (socketInfo.mode & 0o077) !== 0 || (process.getuid && socketInfo.uid !== process.getuid())) throw new Error("local socket directory must be an owner-only directory");
	const repositoryRoot = resolve(options.repositoryRoot);
	const runtimeRoot = await realpath(paths.root);
	await mkdir(options.storePath, { recursive: true, mode: 0o700 });
	const storeRoot = await realpath(options.storePath);
	await mkdir(repositoryRoot, { recursive: true });
	const canonicalRoot = await realpath(repositoryRoot);
	if (inside(canonicalRoot, storeRoot) || inside(canonicalRoot, runtimeRoot)) throw new Error("operational state must be outside the Git brain repository");
	const releaseRuntime = await acquireStoreOwnership(paths.root);
	let engine: BrainEngine | undefined;
	let server: Server | undefined;
 let devices: DeviceAccessController | undefined;
 let ownerUi: OwnerUi | undefined;
 let uiPending: Promise<unknown> = Promise.resolve();
	let requestStop: (() => void) | undefined;
 const activeRequests = new Map<string, AbortController>();
	try {
		const token = await ownerToken(paths.token);
		engine = await createBrainEngine({ repositoryRoot: canonicalRoot, storePath: storeRoot, config: options.config });
		const ownedEngine = engine;
        devices = await DeviceAccessController.create(ownedEngine, options.tailscaleRunner);
        devices.register(ownedEngine.operations);
        await devices.restore();
		try {
			const info = await lstat(paths.socket);
			if (!info.isSocket()) throw new Error("local service socket path is occupied by another file");
			await unlink(paths.socket);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		server = createServer(async (req, res) => {
            const requestAbort = new AbortController();
            let activeRequestId: string | undefined;
            req.once("aborted", () => requestAbort.abort());
            res.once("close", () => { if (!res.writableEnded) requestAbort.abort(); });
            req.socket.once("close", () => { if (!res.writableEnded) requestAbort.abort(); });
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Cache-Control", "no-store");
			try {
				if (req.headers.origin || req.method !== "POST" || req.url !== "/operation") throw new LocalServiceError("invalid_request", "invalid local service request", false, "Use the Manas local service client.");
				if (!sameToken(String(req.headers.authorization ?? ""), "Bearer " + token)) throw new LocalServiceError("unauthorized", "local service authentication failed", false, "Use the owner token for this local installation.");
				const body = JSON.parse(await readOperationBody(req));
				if (!body || typeof body.operation !== "string") throw new Error("operation is required");
                if (body.requestId !== undefined) {
                    if (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId) || activeRequests.has(body.requestId)) throw new Error("invalid request identity");
                    activeRequestId = body.requestId;
                    activeRequests.set(body.requestId, requestAbort);
                }
                if (body.operation === "service.cancel-request") {
                    const controller = typeof body.input?.requestId === "string" ? activeRequests.get(body.input.requestId) : undefined;
                    controller?.abort();
                    res.end(JSON.stringify({ ok: true, data: { cancelled: Boolean(controller) } }));
                    return;
                }

				if (body.repositoryRoot && await realpath(body.repositoryRoot).catch(() => resolve(body.repositoryRoot)) !== canonicalRoot) throw new LocalServiceError("brain_mismatch", "local service owns a different brain", false, "Select the brain configured for the running service.");
				const scope = body.context?.scope ?? "admin";
				if (!["read", "write", "admin"].includes(scope)) throw new Error("invalid operation scope");
				const context: OperationContext = {
					signal: requestAbort.signal, scope, principal: body.context?.principal ?? "local-owner", tenantId: body.context?.tenantId ?? "local",
					...(body.context?.brainId ? { brainId: body.context.brainId } : {}),
					...(Array.isArray(body.context?.allowedAccessLabels) ? { allowedAccessLabels: body.context.allowedAccessLabels } : {}),
				};
                if (body.operation.startsWith("ui.")) {
                    const action = async () => {
                    if (context.scope !== "admin" || context.allowedAccessLabels !== undefined || context.tenantId !== "local" || context.brainId && context.brainId !== (await ownedEngine.repository.getIdentity()).brainId) throw new LocalServiceError("owner_access_required", "Browser administration requires unrestricted local owner authority.", false, "Use the owner CLI.");
                    if (body.operation === "ui.start" || body.operation === "ui.open") {
                        if (ownerUi && body.input?.port !== undefined && Number(body.input.port) !== Number(new URL(ownerUi.origin).port)) throw new Error("UI is already running on another port; stop it before changing ports.");
                        ownerUi ??= await startOwnerUi(ownedEngine, { port: body.input?.port });
                        res.end(JSON.stringify({ ok: true, data: body.operation === "ui.open" ? ownerUi.bootstrap() : { running: true, origin: ownerUi.origin } }));
                    } else if (body.operation === "ui.status") res.end(JSON.stringify({ ok: true, data: { running: !!ownerUi, origin: ownerUi?.origin ?? null } }));
                    else if (body.operation === "ui.stop") { await ownerUi?.close(); ownerUi = undefined; res.end(JSON.stringify({ ok: true, data: { running: false } })); }
                    else throw new Error("Unknown browser administration command.");
                    };
                    const result = uiPending.then(action); uiPending = result.catch(() => {}); await result;
                    return;
                }

				let authentication: unknown;
				if (body.operation === "service.identify-token") authentication = await identifyPersonalAccessToken(ownedEngine.store!, String(body.input?.token));
				if (body.operation === "service.authorize-token") authentication = await authorizePersonalAccessToken(ownedEngine.store!, String(body.input?.token), body.input?.scope, body.input?.tenantId ?? "local");
				if (body.operation === "service.authorize-operation") {
					const principal = body.input?.principal;
					const definition = ownedEngine.operations.get(String(body.input?.name));
					if (principal?.userId) {
						const directory = new SqlTenantDirectory(ownedEngine.store!);
						const brainId = body.input?.input?.brainId ?? (await ownedEngine.repository.getIdentity()).brainId;
						const authorization = await directory.authorizeWithLabels(principal.userId, principal.tenantId, brainId, definition.requiredScope);
						const labels = Array.isArray(body.input?.input?.labels) ? body.input.input.labels : [];
						if (authorization.allowedAccessLabels && labels.some((label: string) => !authorization.allowedAccessLabels!.includes(label))) throw new Error("scope is not authorized");
						authentication = { allowedAccessLabels: authorization.allowedAccessLabels };
					} else authentication = {};
				}
				const data = body.operation === "service.identify-token" ? authentication ?? null
					: body.operation === "service.authorize-token" || body.operation === "service.authorize-operation" ? authentication
					: body.operation === "service.stop"
					? { stopping: true }
					: body.operation === "service.status"
					? { running: true, repositoryRoot: canonicalRoot, storePath: storeRoot, worker: options.worker !== false }
					: body.operation === "service.catalog"
						? ownedEngine.operations.list().map(({ execute: _execute, ...definition }) => definition)
						: await ownedEngine.operations.execute(context, body.operation, body.input ?? {});
				res.end(JSON.stringify({ ok: true, data }));
				if (body.operation === "service.stop") setTimeout(() => { options.onStop?.(); requestStop?.(); }, 0);
			} catch (error) {
				res.statusCode = (error as { code?: string }).code === "unauthorized" ? 401 : (error as { code?: string }).code === "request_too_large" ? 413 : 400;
				res.end(JSON.stringify({ ok: false, error: structuredError(error) }));
			} finally { if (activeRequestId && activeRequests.get(activeRequestId) === requestAbort) activeRequests.delete(activeRequestId); }
		});
		server.requestTimeout = 120_000;
		await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(paths.socket, () => { server!.off("error", reject); done(); }); });
		await chmod(paths.socket, 0o600);
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending: Promise<void> = Promise.resolve();
		const tick = () => {
			pending = (async () => {
				try { await ownedEngine.operations.execute({ scope: "admin", principal: "local-service", tenantId: "local" }, "jobs.run-one", {}); }
				catch (error) { options.onWorkerError?.(error); }
				if (!stopped) timer = setTimeout(tick, 250);
			})();
		};
		if (options.worker !== false) tick();
		let closing: Promise<void> | undefined;
		const close = () => closing ??= (async () => {
			stopped = true;
            for (const controller of activeRequests.values()) controller.abort();
			if (timer) clearTimeout(timer);
			try {
				await new Promise<void>((done, reject) => server!.close((error) => error ? reject(error) : done()));
				await pending;
                await uiPending;
                await ownerUi?.close();
                await devices?.close();
			} finally { try { await ownedEngine.close(); } finally { releaseRuntime(); } }
		})();
		requestStop = () => { void close().catch((error) => options.onWorkerError?.(error)); };
		return { engine, close };
	} catch (error) {
		server?.close();
        await devices?.close();
        await ownerUi?.close();
		try { await engine?.close(); } finally { releaseRuntime(); }
		throw error;
	}
}
export async function callLocalService(config: Config, operation: string, input: Record<string, unknown> = {}, options: { timeoutMs?: number; repositoryRoot?: string; context?: OperationContext; token?: string; signal?: AbortSignal } = {}): Promise<unknown> {
	const paths = localServicePaths(config);
	let token: string;
	try { token = options.token ?? (await readFile(paths.token, "utf8")).trim(); }
	catch { throw new LocalServiceError("service_unavailable", "local Manas service is unavailable", true, "Start manas service start, or use a standalone command while the service is stopped."); }
 const requestId = randomUUID();
 const requestBody = JSON.stringify({ requestId, operation, input, repositoryRoot: options.repositoryRoot, context: options.context });
 if (Buffer.byteLength(requestBody) > maximumRequestBytes) throw new LocalServiceError("request_too_large", "local service input exceeds 8 MiB", false, "Send a smaller operation input.");
 let cancelRemote: (() => void) | undefined;
 return new Promise((done, reject) => {
  let cancelSent = false;
  cancelRemote = () => {
   if (cancelSent || operation === "service.cancel-request") return;
   cancelSent = true;
   void callLocalService(config, "service.cancel-request", { requestId }, { token, timeoutMs: 1000 }).catch(() => {});
  };
  options.signal?.addEventListener("abort", cancelRemote, { once: true });
		const req = request({ socketPath: paths.socket, path: "/operation", method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, signal: options.signal }, (res) => {
			let bytes = 0;
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8_388_608) { clearTimeout(timer); const error = new LocalServiceError("response_too_large", "local service response exceeds 8 MiB", false, "Request fewer results."); reject(error); req.destroy(error); return; } chunks.push(chunk); });
			res.on("error", (error) => { clearTimeout(timer); reject(error); });
			res.on("end", () => {
                clearTimeout(timer);
				try {
					const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (!result.ok) { reject(new LocalServiceError(result.error.code, result.error.message, result.error.retryable, result.error.suggestedFix)); return; }
					done(result.data);
				} catch (error) { reject(error); }
			});
		});
		const timer = setTimeout(() => { const error = new LocalServiceError("service_timeout", "local service request timed out", true, "Check service health and retry with a suitable operation deadline."); cancelRemote?.(); reject(error); req.destroy(error); }, options.timeoutMs ?? (operation === "google.accounts.connect" ? 360_000 : 120_000));
		req.on("error", (error) => { clearTimeout(timer); reject(error instanceof LocalServiceError ? error : new LocalServiceError("service_unavailable", "local Manas service is unavailable", true, "Start the local service or retry after it recovers.")); });
		req.end(requestBody);
 }).finally(() => { if (cancelRemote) options.signal?.removeEventListener("abort", cancelRemote); });
}
export async function localServiceRegistry(config: Config, repositoryRoot?: string): Promise<OperationRegistry> {
	const definitions = await callLocalService(config, "service.catalog", {}, { repositoryRoot, timeoutMs: 2_000 }) as Array<Omit<ReturnType<OperationRegistry["get"]>, "execute">>;
	const registry = new OperationRegistry();
	for (const definition of definitions) registry.register({ ...definition, execute: (context, input) => callLocalService(config, definition.name, input as Record<string, unknown>, { repositoryRoot, context, signal: context.signal }) });
	return registry;
}
