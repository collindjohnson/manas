import { createHash } from "node:crypto";
import type { BrainStore, SqlValue } from "./store";

export interface DatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  up(store: BrainStore): Promise<void>;
  down?(store: BrainStore): Promise<void>;
  verify(store: BrainStore): Promise<void>;
}

export interface MigrationBackupContext {
  fromVersion: number;
  toVersion: number;
}

export interface MigrationRunOptions {
  backup?: (context: MigrationBackupContext) => Promise<void>;
}

export interface MigrationRunResult {
  applied: number[];
  currentVersion: number;
}

export const MIGRATION_HISTORY_SCHEMA = "CREATE TABLE IF NOT EXISTS brain_migration_history (\n" +
  "  version integer PRIMARY KEY,\n" +
  "  name text NOT NULL,\n" +
  "  checksum text NOT NULL,\n" +
  "  applied_at timestamptz NOT NULL DEFAULT now()\n" +
  ");\n";

function checksum(version: number, name: string, sql: string): string {
  return createHash("sha256").update(String(version) + "\n" + name + "\n" + sql).digest("hex");
}

export function sqlMigration(
  version: number,
  name: string,
  sql: string,
  verify: (store: BrainStore) => Promise<void>,
  down?: (store: BrainStore) => Promise<void>,
): DatabaseMigration {
  return {
    version,
    name,
    checksum: checksum(version, name, sql),
    up: (store) => store.exec(sql),
    ...(down ? { down } : {}),
    verify,
  };
}

async function readLegacyVersion(store: BrainStore): Promise<number | undefined> {
  try {
    const rows = await store.query<{ value: string }>("SELECT value FROM brain_schema_meta WHERE key = 'schema_version'");
    const version = Number(rows[0]?.value);
    return Number.isInteger(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function readHistory(store: BrainStore): Promise<Array<{ version: number; name: string; checksum: string }>> {
  return store.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM brain_migration_history ORDER BY version");
}

async function recordMigration(store: BrainStore, migration: DatabaseMigration): Promise<void> {
  const values: SqlValue[] = [migration.version, migration.name, migration.checksum];
  await store.query(
    "INSERT INTO brain_migration_history (version, name, checksum) VALUES ($1, $2, $3)",
    values,
  );
  await store.query(
    "INSERT INTO brain_schema_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [String(migration.version)],
  );
}

export async function runDatabaseMigrations(
  store: BrainStore,
  migrations: DatabaseMigration[],
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (!ordered.length || ordered.some((migration, index) => index > 0 && migration.version <= ordered[index - 1]!.version)) throw new Error("database migrations must have strictly increasing versions");
  await store.exec(MIGRATION_HISTORY_SCHEMA);
  const latest = ordered[ordered.length - 1]!.version;
  const history = await readHistory(store);
  const legacyVersion = await readLegacyVersion(store);
  const known = new Map(ordered.map((migration) => [migration.version, migration]));
  for (const entry of history) {
    const migration = known.get(entry.version);
    if (!migration) throw new Error("database contains an unknown migration version " + entry.version);
    if (migration.name !== entry.name || migration.checksum !== entry.checksum) throw new Error("database migration checksum mismatch at version " + entry.version);
  }
  const recordedVersion = history.at(-1)?.version ?? 0;
  const detectedVersion = Math.max(recordedVersion, legacyVersion ?? 0);
  if (detectedVersion > latest) throw new Error("database schema version " + detectedVersion + " is newer than supported version " + latest);
  if (history.length === 0 && legacyVersion === latest) {
    const baseline = known.get(latest)!;
    await baseline.verify(store);
    await store.query(
      "INSERT INTO brain_migration_history (version, name, checksum) VALUES ($1, $2, $3)",
      [baseline.version, baseline.name, baseline.checksum],
    );
    return { applied: [], currentVersion: latest };
  }
  const pending = ordered.filter((migration) => migration.version > recordedVersion);
  if (!pending.length) {
    if (recordedVersion > 0) await known.get(recordedVersion)!.verify(store);
    return { applied: [], currentVersion: recordedVersion };
  }
  await options.backup?.({ fromVersion: detectedVersion, toVersion: latest });
  const applied: number[] = [];
  for (const migration of pending) {
    await store.transaction(async (transaction) => {
      await migration.up(transaction);
      await migration.verify(transaction);
      await recordMigration(transaction, migration);
    });
    applied.push(migration.version);
  }
  return { applied, currentVersion: pending.at(-1)!.version };
}

export async function rollbackDatabaseMigration(store: BrainStore, migration: DatabaseMigration): Promise<void> {
  if (!migration.down) throw new Error("migration " + migration.version + " does not support rollback");
  await store.transaction(async (transaction) => {
    await migration.down!(transaction);
    await transaction.query("DELETE FROM brain_migration_history WHERE version = $1", [migration.version]);
    const previous = await transaction.query<{ version: number }>("SELECT version FROM brain_migration_history ORDER BY version DESC LIMIT 1");
    await transaction.query(
      "INSERT INTO brain_schema_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [String(previous[0]?.version ?? 0)],
    );
  });
}
