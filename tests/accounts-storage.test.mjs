import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-accounts-storage-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as accountsGet } from "./src/app/api/accounts/route.ts";
		`,
		resolveDir: root,
		sourcefile: "accounts-storage-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, createSession, accountsGet } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** An admin on a Team license with 700 bytes of mail and 300 bytes of Drive, next to a user who stores nothing, under a 5000-byte cap. */
async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('other', 'other@one.test', 'hash', 'Other', 'user', 0, 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at)
			VALUES ('default', 'test-instance', 'team', 'active', '[]', 1);
		INSERT INTO app_settings (id, storage_limit_bytes, updated_at) VALUES ('default', 5000, 1)
			ON CONFLICT (id) DO UPDATE SET storage_limit_bytes = excluded.storage_limit_bytes;
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, size, created_at)
			VALUES ('m1', 'admin', 'inbound', 'x@two.test', 'owner@one.test', 700, 1);
		INSERT INTO drive_items (id, owner_id, kind, name, size, created_at, updated_at)
			VALUES ('d1', 'admin', 'file', 'one.bin', 300, 1, 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("tests must never contact a real service"); });
	const session = await createSession(env, "admin");
	const get = () => accountsGet(new Request("https://mailflare.test/api/accounts", { headers: { Authorization: `Bearer ${session}` } }));
	return { database, env, session, get };
}

test("accounts list reports storage per user and the limit", async (t) => {
	const f = await fixture(t);
	const response = await f.get();
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.storageLimit, 5000);
	assert.equal(body.accounts.find((account) => account.id === "admin").storageUsed, 1000);
	assert.equal(body.accounts.find((account) => account.id === "other").storageUsed, 0);
});

test("without a cap the limit is null and usage is still reported", async (t) => {
	const f = await fixture(t);
	f.database.db.exec("UPDATE app_settings SET storage_limit_bytes = NULL");
	const body = await (await f.get()).json();
	assert.equal(body.storageLimit, null);
	assert.equal(body.accounts.find((account) => account.id === "admin").storageUsed, 1000);
});
