import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// NetfoMailBox is built for its own team: the upstream Pro/Team gate must stay off whatever the license row says.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-self-hosted-license-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getLicenseEntitlements, getLicenseStatus, SELF_HOSTED_LICENSE } from "./src/lib/licenses/service.ts";
			export { getAccountSeatError } from "./src/lib/licenses/seats.ts";
			export { isTeamMailboxSharingEnabled } from "./src/lib/mailboxes/access-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "self-hosted-license-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, getLicenseEntitlements, getLicenseStatus, SELF_HOSTED_LICENSE, getAccountSeatError, isTeamMailboxSharingEnabled } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const FULL_ENTITLEMENTS = {
	plan: "team",
	canCustomizeBranding: true,
	canManageAccounts: true,
	canShareMailboxes: true,
	accountSeatLimit: null,
	canForwardEmail: true,
};

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("the license service must never contact Paymug"); });
	return { database, env };
}

test("every installation gets the full Team entitlements without a key", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await getLicenseEntitlements(f.env), FULL_ENTITLEMENTS);
	const status = await getLicenseStatus(f.env);
	assert.equal(status.plan, "team");
	assert.equal(status.state, "active");
	assert.equal(status.active, true);
	assert.equal(status.seatLimit, null);
	const row = f.database.db.prepare("SELECT instance_id FROM license_settings WHERE id = 'default'").get();
	assert.ok(row?.instance_id, "the status call still creates the instance row");
	assert.equal(status.instanceId, row.instance_id, "the installation keeps its own instance id");
	assert.equal(await getAccountSeatError(f.env), null);
	assert.equal(await isTeamMailboxSharingEnabled(), true);
});

test("a community, inactive or seat-limited license row changes nothing", async (t) => {
	const f = await fixture(t);
	for (const [plan, state] of [["community", "inactive"], ["pro", "expired"], ["pro", "active"], ["team", "deactivated"]]) {
		f.database.db.exec(`
			INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at)
				VALUES ('default', 'kept-instance', '${plan}', '${state}', '[]', 1, 1)
				ON CONFLICT (id) DO UPDATE SET plan = excluded.plan, state = excluded.state, seat_limit = excluded.seat_limit;
		`);
		assert.deepEqual(await getLicenseEntitlements(f.env), FULL_ENTITLEMENTS, `${plan}/${state}`);
		assert.equal(await getAccountSeatError(f.env), null, `${plan}/${state} must not count seats`);
	}
});

test("a database without the license table still grants everything", async (t) => {
	const f = await fixture(t);
	f.database.db.exec("DROP TABLE license_settings");
	assert.deepEqual(await getLicenseEntitlements(f.env), FULL_ENTITLEMENTS);
	assert.deepEqual(await getLicenseStatus(f.env), SELF_HOSTED_LICENSE);
});
