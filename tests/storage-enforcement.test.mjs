import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-storage-enforcement-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { sendEmail } from "./src/lib/email/send.ts";
			export { importMessagesToMailbox } from "./src/lib/import/service.ts";
			export { getSendErrorStatus } from "./src/app/api/send/error-utils.ts";
			export { StorageLimitError } from "./src/lib/storage/usage.ts";
		`,
		resolveDir: root,
		sourcefile: "storage-enforcement-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, sendEmail, importMessagesToMailbox, getSendErrorStatus, StorageLimitError } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** A user who owns sam@one.test and already occupies `used` bytes, on an installation capped at `limit` bytes. */
async function fixture(t, { limit = 1000, used = 1000 } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO app_settings (id, storage_limit_bytes, updated_at) VALUES ('default', ${limit}, 1)
			ON CONFLICT (id) DO UPDATE SET storage_limit_bytes = excluded.storage_limit_bytes;
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u1', 'sam@one.test', 'hash', 'Sam', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'zone', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'sam', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, size, created_at)
			VALUES ('m1', 'u1', 'mb1', 'inbound', 'x@two.test', 'sam@one.test', ${used}, 1);
	`);
	const stored = [];
	const env = {
		DB: database,
		BUCKET: { put: async (key) => stored.push(key), delete: async () => undefined },
		MAILFLARE_RUNTIME: "node",
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return { database, env, stored, userId: "u1", mailboxId: "mb1", destination: { type: "system", section: "sent" } };
}

/** A minimal RFC 822 message with its own Message-ID, padded to exactly `bytes` bytes. */
function rawOf(bytes, id) {
	const head = `From: x@two.test\r\nTo: sam@one.test\r\nSubject: s\r\nMessage-ID: <${id}@two.test>\r\n\r\n`;
	assert.ok(head.length <= bytes, `a ${bytes}-byte message cannot hold its headers`);
	const encoded = new TextEncoder().encode(head + "x".repeat(bytes - head.length));
	const raw = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
	assert.equal(raw.byteLength, bytes);
	return raw;
}

const countOf = (f, where) => f.database.db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get().n;

test("sendEmail refuses when the user is at the cap, even without attachments", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		sendEmail(f.env, { userId: f.userId, mailboxId: f.mailboxId, from: "sam@one.test", to: ["x@two.test"], subject: "s", text: "t" }),
		(error) => error instanceof StorageLimitError && error.message === "Storage limit reached",
	);
	assert.equal(countOf(f, "direction = 'outbound'"), 0);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM outbound_jobs").get().n, 0);
	assert.deepEqual(f.stored, []);
});

test("sendEmail counts attachments against the cap", async (t) => {
	const f = await fixture(t, { limit: 1200, used: 1000 });
	const content = new ArrayBuffer(300);
	await assert.rejects(
		sendEmail(f.env, { userId: f.userId, mailboxId: f.mailboxId, from: "sam@one.test", to: ["x@two.test"], subject: "s", text: "t", attachments: [{ filename: "big.bin", type: "application/octet-stream", content, disposition: "attachment" }] }),
		(error) => error instanceof StorageLimitError && error.used === 1000 && error.limit === 1200 && error.requested === 301,
	);
	assert.equal(countOf(f, "direction = 'outbound'"), 0);
});

test("getSendErrorStatus maps the storage message to 413", () => {
	assert.equal(getSendErrorStatus("Storage limit reached. Delete mail or files to send."), 413);
	assert.equal(getSendErrorStatus("Storage limit reached"), 413);
	assert.equal(getSendErrorStatus("Mailbox is required"), 400);
});

test("import stops at the cap, keeps earlier messages and rethrows", async (t) => {
	const f = await fixture(t, { limit: 1200, used: 1000 });
	const small = rawOf(100, "small");
	const big = rawOf(300, "big");
	await assert.rejects(
		importMessagesToMailbox(f.env, {
			userId: f.userId,
			mailboxId: f.mailboxId,
			destination: f.destination,
			messages: [{ filename: "1.eml", raw: small }, { filename: "2.eml", raw: big }],
		}),
		(error) => error instanceof StorageLimitError,
	);
	assert.equal(countOf(f, "raw_r2_key LIKE 'imports/%'"), 1);
	// The refused message never reached the bucket either.
	const [kept] = f.database.db.prepare("SELECT raw_r2_key AS key FROM messages WHERE raw_r2_key LIKE 'imports/%'").all();
	assert.deepEqual(f.stored, [kept.key]);
});

test("import without a cap keeps counting failures as skipped", async (t) => {
	const f = await fixture(t, { limit: 0, used: 1000 });
	const result = await importMessagesToMailbox(f.env, {
		userId: f.userId,
		mailboxId: f.mailboxId,
		destination: f.destination,
		messages: [{ filename: "1.eml", raw: rawOf(100, "one") }, { filename: "2.eml", raw: rawOf(300, "two") }],
	});
	assert.deepEqual(result, { imported: 2, skipped: 0, errors: [] });
});
