import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-storage-size-write-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { importMessagesToMailbox } from "./src/lib/import/service.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "storage-size-write-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, importMessagesToMailbox, processInboundMessage } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const rawMime = (subject) => new TextEncoder().encode([
	"From: Ann <ann@two.test>",
	"To: Sam <sam@one.test>",
	`Subject: ${subject}`,
	`Message-ID: <${subject}@two.test>`,
	"Date: Tue, 2 Feb 2021 10:00:00 +0000",
	"",
	"Hello there",
].join("\r\n")).buffer;

const toBytes = (value) => value instanceof ArrayBuffer
	? new Uint8Array(value.slice(0))
	: ArrayBuffer.isView(value)
		? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
		: new TextEncoder().encode(String(value));

/** An in-memory stand-in for the R2 binding: enough for the raw MIME round trip. */
function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		put: async (key, value) => { objects.set(key, toBytes(value)); },
		get: async (key) => {
			const bytes = objects.get(key);
			if (!bytes) return null;
			return {
				size: bytes.byteLength,
				arrayBuffer: async () => bytes.slice().buffer,
				text: async () => new TextDecoder().decode(bytes),
			};
		},
		head: async (key) => (objects.has(key) ? { size: objects.get(key).byteLength } : null),
		delete: async (key) => { objects.delete(key); },
	};
}

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	// Spam protection is off so the inbound path needs no DNS or intelligence lookups.
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, spam_protection_enabled, created_at)
			VALUES ('u1', 'sam@one.test', 'hash', 'Sam', 'user', 0, 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'one.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'sam', 1);
	`);
	const bucket = memoryBucket();
	const env = { DB: database, BUCKET: bucket, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	// Contact upserts look the sender up on Gravatar; keep the test offline.
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(null, { status: 404 });
	t.after(() => {
		globalThis.fetch = originalFetch;
		delete globalThis.__mailflareNodeEnv;
	});
	return { database, env, bucket, userId: "u1", mailboxId: "mb1" };
}

test("import records the raw byte length in messages.size", async (t) => {
	const f = await fixture(t);
	const raw = rawMime("imported");
	const result = await importMessagesToMailbox(f.env, {
		userId: f.userId,
		mailboxId: f.mailboxId,
		destination: { type: "system", section: "sent" },
		messages: [{ filename: "a.eml", raw }],
	});
	assert.deepEqual(result, { imported: 1, skipped: 0, errors: [] });
	const row = f.database.db.prepare("SELECT size, raw_r2_key FROM messages").get();
	assert.equal(f.bucket.objects.get(row.raw_r2_key)?.byteLength, raw.byteLength);
	assert.equal(row.size, raw.byteLength);
});

test("inbound delivery records the raw byte length in messages.size", async (t) => {
	const f = await fixture(t);
	const raw = rawMime("delivered");
	const rawR2Key = "inbound/delivered.eml";
	await f.bucket.put(rawR2Key, raw);
	await processInboundMessage(f.env, { from: "ann@two.test", to: "sam@one.test", rawR2Key });
	const row = f.database.db.prepare("SELECT size, raw_r2_key, status FROM messages").get();
	assert.equal(row?.status, "received");
	assert.equal(row.raw_r2_key, rawR2Key);
	assert.equal(row.size, raw.byteLength);
});
