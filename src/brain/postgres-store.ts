import { BRAIN_STORE_MIGRATIONS } from "./store";
import { runDatabaseMigrations } from "./migrations";
import { Pool, type PoolClient } from "pg";


export type SqlValue = string | number | boolean | null | Uint8Array;

export interface PostgresBrainStore {
	query<T extends Record<string, unknown>>(sql: string, parameters?: SqlValue[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	transaction<T>(action: (store: PostgresBrainStore) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

class ClientStore implements PostgresBrainStore {
	constructor(private readonly client: Pool | PoolClient, private readonly pool?: Pool) {}

	async query<T extends Record<string, unknown>>(sql: string, parameters: SqlValue[] = []): Promise<T[]> {
		return (await this.client.query<T>(sql, parameters)).rows;
	}

	async exec(sql: string): Promise<void> {
		await this.client.query(sql);
	}

	async transaction<T>(action: (store: PostgresBrainStore) => Promise<T>): Promise<T> {
		if (this.client instanceof Pool) {
			const client = await this.client.connect();
			try {
				await client.query("BEGIN");
				const result = await action(new ClientStore(client));
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally { client.release(); }
		}
		throw new Error("nested transactions are not supported");
	}

	async close(): Promise<void> {
		if (this.pool) await this.pool.end();
	}
}

export async function openPostgresBrainStore(connectionString: string): Promise<PostgresBrainStore> {
	const pool = new Pool({ connectionString });
	try {
		try {
			await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown extension error";
			throw new Error(`PostgreSQL pgvector extension is required and could not be installed: ${detail}`);
		}
		const store = new ClientStore(pool, pool);
		await runDatabaseMigrations(store, BRAIN_STORE_MIGRATIONS);
		return store;
	} catch (error) {
		await pool.end();
		throw error;
	}
}
