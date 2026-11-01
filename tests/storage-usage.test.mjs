import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-storage-usage-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export * from "./src/lib/storage/usage.ts";
		`,
		resolveDir: root,
		sourcefile: "storage-usage-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, getStorageLimit, getStorageUsage, getStorageUsageForUsers, assertStorageAvailable, StorageLimitError } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('a', 'a@one.test', 'hash', 'A', 'user', 0, 1),
			('b', 'b@one.test', 'hash', 'B', 'user', 0, 1);
		INSERT INTO drive_items (id, owner_id, kind, name, size, created_at, updated_at) VALUES ('d1', 'a', 'file', 'one.bin', 100, 1, 1);
		INSERT INTO drive_items (id, owner_id, kind, name, size, trashed_at, created_at, updated_at) VALUES ('d2', 'a', 'file', 'two.bin', 50, 1, 1, 1);
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, size, created_at) VALUES
			('m1', 'a', 'inbound', 'x@two.test', 'a@one.test', 1000, 1),
			('m2', 'a', 'inbound', 'x@two.test', 'a@one.test', 200, 1);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, trashed_at, created_at)
			VALUES ('at1', 'm1', 'f.pdf', 'application/pdf', 30, 'att/at1', 1, 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return { database, env, db: getDb(env) };
}

test("usage sums drive, mail and attachments including trashed rows", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await getStorageUsage(f.db, "a"), { drive: 150, mail: 1200, attachments: 30, total: 1380 });
	assert.deepEqual(await getStorageUsage(f.db, "b"), { drive: 0, mail: 0, attachments: 0, total: 0 });
});

test("usage for many users groups per user", async (t) => {
	const f = await fixture(t);
	const map = await getStorageUsageForUsers(f.db, ["a", "b", "missing"]);
	assert.equal(map.get("a").total, 1380);
	assert.deepEqual(map.get("a"), { drive: 150, mail: 1200, attachments: 30, total: 1380 });
	assert.equal(map.get("b").total, 0);
	assert.equal(map.get("missing").total, 0);
	assert.equal((await getStorageUsageForUsers(f.db, [])).size, 0);
});

test("null and zero limits mean unlimited", async (t) => {
	const f = await fixture(t);
	assert.equal(await getStorageLimit(f.env), null);
	f.database.db.exec("INSERT INTO app_settings (id, storage_limit_bytes, updated_at) VALUES ('default', 0, 1)");
	assert.equal(await getStorageLimit(f.env), null);
	await assertStorageAvailable(f.env, f.db, "a", 10 ** 12);
});

test("assertStorageAvailable allows the exact boundary and refuses one byte more", async (t) => {
	const f = await fixture(t);
	f.database.db.exec("INSERT INTO app_settings (id, storage_limit_bytes, updated_at) VALUES ('default', 1400, 1)");
	assert.equal(await getStorageLimit(f.env), 1400);
	await assertStorageAvailable(f.env, f.db, "a", 20);
	await assert.rejects(
		assertStorageAvailable(f.env, f.db, "a", 21),
		(error) => error instanceof StorageLimitError && error.message === "Storage limit reached" && error.used === 1380 && error.limit === 1400 && error.requested === 21,
	);
	await assertStorageAvailable(f.env, f.db, "b", 1400);
	await assert.rejects(assertStorageAvailable(f.env, f.db, "b", 1401), StorageLimitError);
});
