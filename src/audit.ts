import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type AuditStatus = "pending" | "success" | "failed" | "rolled_back";

export interface AuditEvent {
	/** Unique operation identifier — used for rollback. */
	operationId: string;
	/** For bulk operations: id of the parent operation (single entity ops are their own parent). */
	parentOperationId: string | null;
	timestamp: string;
	/** Identifies the acting user. Derived from the Shopware integration client id. */
	user: string;
	/** Optional friendly label (MCP_USER_LABEL env). */
	userLabel: string | null;
	/** MCP tool that triggered the change, e.g. "product_update". */
	tool: string;
	/** "write" for normal operations, "rollback" for undo operations. */
	action: "write" | "rollback";
	entityType: string;
	entityId: string | null;
	sku: string | null;
	/** What the user asked to change. */
	payloadIn: unknown;
	/** State BEFORE the change — the gold for rollback. null if create. */
	payloadBefore: unknown;
	status: AuditStatus;
	error?: string | null;
	durationMs?: number | null;
	/** When this event is a rollback: operationId of the original it reverts. */
	rollbackOf?: string | null;
	/** When this event was reverted: operationId of the rollback event. */
	rolledBackBy?: string | null;
}

const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB before rotation
const MAX_ROTATED = 5;

/**
 * Append-only JSONL audit log. One line per event.
 *
 * Design goals:
 * - Crash-safe: append-only, never rewrites in place
 * - Dependency-free: no SQLite/native bindings
 * - Per-user instances are fine — each MCP process (= one Shopware integration)
 *   writes its own user into every event, so a shared file stays attributable.
 *   For true central aggregation, point AUDIT_DIR at a shared drive.
 *
 * Status updates (pending → success/failed/rolled_back) are written as NEW lines
 * with the same operationId; readers fold them so the latest status wins. This
 * keeps the file strictly append-only (no in-place edits, no corruption risk).
 */
export class AuditLog {
	private dir: string;
	private file: string;
	private logger: Logger;
	private user: string;
	private userLabel: string | null;

	constructor(logger: Logger) {
		this.logger = logger;
		this.dir = process.env.AUDIT_DIR || join(__dirname, "..", "audit");
		this.file = join(this.dir, "events.jsonl");
		this.user = process.env.SHOPWARE_API_CLIENT_ID || "unknown";
		this.userLabel = process.env.MCP_USER_LABEL || null;
		this.ensureDir();
	}

	private ensureDir(): void {
		try {
			if (!existsSync(this.dir)) {
				mkdirSync(this.dir, { recursive: true });
			}
		} catch (err) {
			this.logger.logError("STARTUP", "Failed to create audit dir", err);
		}
	}

	private rotateIfNeeded(): void {
		try {
			if (!existsSync(this.file)) return;
			if (statSync(this.file).size < MAX_LOG_SIZE_BYTES) return;
			for (let i = MAX_ROTATED - 1; i >= 1; i--) {
				const from = `${this.file}.${i}`;
				const to = `${this.file}.${i + 1}`;
				if (existsSync(from)) {
					try {
						renameSync(from, to);
					} catch {
						/* ignore */
					}
				}
			}
			renameSync(this.file, `${this.file}.1`);
		} catch {
			/* keep writing to current file on rotation failure */
		}
	}

	private appendLine(obj: unknown): void {
		try {
			this.rotateIfNeeded();
			appendFileSync(this.file, `${JSON.stringify(obj)}\n`, "utf8");
		} catch (err) {
			this.logger.logError("STARTUP", "Audit append failed", err);
		}
	}

	/** Generate a new operation id. */
	newOperationId(): string {
		return randomUUID();
	}

	/**
	 * Record the start of a write operation (status=pending) including the
	 * pre-change snapshot. Returns the full event so the caller can later
	 * finalize it.
	 */
	begin(params: {
		operationId?: string;
		parentOperationId?: string | null;
		tool: string;
		action?: "write" | "rollback";
		entityType: string;
		entityId: string | null;
		sku?: string | null;
		payloadIn: unknown;
		payloadBefore: unknown;
		rollbackOf?: string | null;
	}): AuditEvent {
		const event: AuditEvent = {
			operationId: params.operationId ?? this.newOperationId(),
			parentOperationId: params.parentOperationId ?? null,
			timestamp: new Date().toISOString(),
			user: this.user,
			userLabel: this.userLabel,
			tool: params.tool,
			action: params.action ?? "write",
			entityType: params.entityType,
			entityId: params.entityId,
			sku: params.sku ?? null,
			payloadIn: params.payloadIn,
			payloadBefore: params.payloadBefore,
			status: "pending",
			rollbackOf: params.rollbackOf ?? null,
		};
		this.appendLine(event);
		return event;
	}

	/** Finalize an operation — appends a status-update line (append-only). */
	finalize(
		event: AuditEvent,
		status: AuditStatus,
		extra?: { error?: string; durationMs?: number },
	): void {
		this.appendLine({
			operationId: event.operationId,
			_statusUpdate: true,
			status,
			error: extra?.error ?? null,
			durationMs: extra?.durationMs ?? null,
			timestamp: new Date().toISOString(),
		});
	}

	/** Mark an original operation as rolled back, referencing the rollback op. */
	markRolledBack(originalOperationId: string, rollbackOperationId: string): void {
		this.appendLine({
			operationId: originalOperationId,
			_statusUpdate: true,
			status: "rolled_back" as AuditStatus,
			rolledBackBy: rollbackOperationId,
			timestamp: new Date().toISOString(),
		});
	}

	/** Read & fold all events (latest status wins per operationId). */
	private readAll(): AuditEvent[] {
		if (!existsSync(this.file)) return [];
		const byId = new Map<string, AuditEvent>();
		const order: string[] = [];
		const content = readFileSync(this.file, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			const id = obj.operationId as string;
			if (!id) continue;
			if (obj._statusUpdate) {
				const existing = byId.get(id);
				if (existing) {
					existing.status = (obj.status as AuditStatus) ?? existing.status;
					if (obj.error !== undefined) existing.error = obj.error as string;
					if (obj.durationMs !== undefined)
						existing.durationMs = obj.durationMs as number;
					if (obj.rolledBackBy !== undefined)
						existing.rolledBackBy = obj.rolledBackBy as string;
				}
			} else {
				if (!byId.has(id)) order.push(id);
				byId.set(id, obj as unknown as AuditEvent);
			}
		}
		return order.map((id) => byId.get(id)).filter(Boolean) as AuditEvent[];
	}

	/** Search events with simple filters. Newest first. */
	search(filter: {
		user?: string;
		tool?: string;
		entityId?: string;
		sku?: string;
		status?: AuditStatus;
		action?: "write" | "rollback";
		from?: string;
		to?: string;
		operationId?: string;
		parentOperationId?: string;
		limit?: number;
	}): AuditEvent[] {
		let events = this.readAll();
		const f = filter;
		if (f.user) events = events.filter((e) => e.user.includes(f.user as string));
		if (f.tool) events = events.filter((e) => e.tool === f.tool);
		if (f.entityId) events = events.filter((e) => e.entityId === f.entityId);
		if (f.sku) events = events.filter((e) => e.sku === f.sku);
		if (f.status) events = events.filter((e) => e.status === f.status);
		if (f.action) events = events.filter((e) => e.action === f.action);
		if (f.operationId)
			events = events.filter((e) => e.operationId === f.operationId);
		if (f.parentOperationId)
			events = events.filter(
				(e) => e.parentOperationId === f.parentOperationId,
			);
		if (f.from) events = events.filter((e) => e.timestamp >= (f.from as string));
		if (f.to) events = events.filter((e) => e.timestamp <= (f.to as string));
		events.reverse(); // newest first
		if (f.limit && f.limit > 0) events = events.slice(0, f.limit);
		return events;
	}

	/** Get a single operation plus its children (for bulk). */
	get(operationId: string): { operation: AuditEvent | null; children: AuditEvent[] } {
		const all = this.readAll();
		const operation = all.find((e) => e.operationId === operationId) ?? null;
		const children = all.filter((e) => e.parentOperationId === operationId);
		return { operation, children };
	}
}

// ============================================================
// Singleton accessor — initialized once in index.ts, used by tools
// without threading it through every function signature.
// ============================================================

let _instance: AuditLog | null = null;

export function initAuditLog(logger: Logger): AuditLog {
	_instance = new AuditLog(logger);
	return _instance;
}

export function getAuditLog(): AuditLog {
	if (!_instance) {
		throw new Error("AuditLog accessed before initialization");
	}
	return _instance;
}

/**
 * Convenience wrapper: snapshot is taken by the caller, this records the
 * begin/finalize lifecycle around an async write operation.
 */
export async function withAudit<T>(
	params: {
		operationId?: string;
		parentOperationId?: string | null;
		tool: string;
		action?: "write" | "rollback";
		entityType: string;
		entityId: string | null;
		sku?: string | null;
		payloadIn: unknown;
		payloadBefore: unknown;
		rollbackOf?: string | null;
	},
	fn: () => Promise<T>,
): Promise<{ result: T; event: AuditEvent }> {
	const audit = getAuditLog();
	const event = audit.begin(params);
	const start = Date.now();
	try {
		const result = await fn();
		audit.finalize(event, "success", { durationMs: Date.now() - start });
		return { result, event };
	} catch (err) {
		audit.finalize(event, "failed", {
			durationMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}
