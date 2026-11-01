# Combined Storage Cap and AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One per-user storage cap that counts mail, attachments and Drive files together, enforced on uploads, sends and imports, visible to users and admins, plus the files needed to run Mailflare on EC2 with S3 and SES.

**Architecture:** A new `messages.size` column records raw MIME bytes; a small usage module sums three tables per user on demand and throws `StorageLimitError` when a write would exceed the cap. The existing global Drive setting is renamed and reused as the cap. Deployment is config only under `deploy/aws/`.

**Tech Stack:** TypeScript, Next.js App Router, Drizzle ORM (SQLite, PostgreSQL, MySQL dialects), `node:test` with esbuild-bundled entry points, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-01-storage-cap-and-aws-deployment-design.md`

**Execution order:** Tasks 1 and 2 are the foundation and run first, sequentially, on branch `storage-cap`. Tasks 3, 4, 5 and 6 are independent of each other and run in parallel, each in its own git worktree branched from `storage-cap` after Task 2 is committed (Task 6 may start at any time). Task 7 merges and verifies.

## Global Constraints

- Every schema change ships a migration in all three dialects: `drizzle/migrations/` (SQLite), `drizzle/migrations-pg/`, `drizzle/migrations-mysql/`, then `npm run db:bundle`; `src/lib/migrations/bundle.json` is gitignored, the postgres and mysql bundles are committed.
- Tests are `node --test tests/<file>.test.mjs`, must not need Workers bindings, and follow the esbuild entry pattern of `tests/account-alias-selection.test.mjs` (in-memory `SqliteDatabase`, `applyMigrations(database, "drizzle/migrations")`, `globalThis.__mailflareNodeEnv = env`).
- Usage definition: `total = drive + mail + attachments` with `drive = SUM(drive_items.size) WHERE owner_id = user`, `mail = SUM(messages.size) WHERE user_id = user`, `attachments = SUM(message_attachments.size) JOIN messages ON message_id WHERE messages.user_id = user`.
- A null or non-positive limit means unlimited.
- `StorageLimitError.message` is exactly `Storage limit reached`.
- User-facing copy: Drive upload refusal `Not enough storage left for this file`; send refusal `Storage limit reached. Delete mail or files to send.`; import job error `Storage limit reached`.
- New translation strings go only into `src/lib/i18n/en.json` (other locales fall back to English via `messages[key] ?? en[key]`). Existing `general.drive*` keys keep their names; only their English values change.
- Inbound mail is never refused for storage.
- Use tabs for indentation, matching the repository.

## Review Focus

1. Trashed Drive items and trashed attachments still count until purged: usage must include rows with `trashed_at` set. (Test in Task 2.)
2. Exact boundary: `used + requested == limit` is allowed; one byte more is refused. (Test in Task 2.)
3. A limit of `null` or `0` means unlimited everywhere, so an admin clearing the field never blocks anyone. (Test in Task 2.)
4. A user already over the cap sending a message with no attachments is still refused, because the stored message adds rows. (Test in Task 4.)
5. An import chunk that hits the cap mid-way leaves the already-imported messages in place, marks the job failed with the reason, and keeps the cursor. (Test in Task 4.)

---

### Task 1: Schema and migrations

**Files:**
- Modify: `src/db/schema/index.ts` (messages table lines 274-330, appSettings table lines 877-908)
- Create: `drizzle/migrations/0080_storage_cap.sql`
- Modify: `drizzle/migrations/meta/_journal.json`
- Create: `drizzle/migrations-pg/0004_storage_cap.sql`
- Create: `drizzle/migrations-mysql/0004_storage_cap.sql`
- Modify (generated): `src/lib/migrations/bundle-postgres.json`, `src/lib/migrations/bundle-mysql.json`
- Test: `tests/database-dialects.test.mjs` (existing)

**Interfaces:**
- Produces: `messages.size` (Drizzle `size: integer("size").notNull().default(0)`), index `messages_user_size_idx (user_id, size)`, `appSettings.storageLimitBytes` (column `storage_limit_bytes`, nullable integer). `appSettings.driveStorageLimitBytes` no longer exists.

- [ ] **Step 1: Run the dialect test to see it pass before changes**

Run: `node --test tests/database-dialects.test.mjs`
Expected: PASS

- [ ] **Step 2: Edit the schema**

In `messages`, add `size: integer("size").notNull().default(0),` directly after `rawR2Key`, with the doc comment `/** Bytes of the raw MIME object in the bucket; 0 when none is stored. Counted toward the user's storage cap. */`. Add `index("messages_user_size_idx").on(t.userId, t.size),` to the messages index list. In `appSettings`, replace `driveStorageLimitBytes: integer("drive_storage_limit_bytes")` with `storageLimitBytes: integer("storage_limit_bytes")` and change its comment to `/** Per-user storage cap in bytes across mail, attachments and Drive; null means unlimited. */`.

- [ ] **Step 3: Write the SQLite migration**

`drizzle/migrations/0080_storage_cap.sql`:

```sql
ALTER TABLE `messages` ADD `size` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `messages_user_size_idx` ON `messages` (`user_id`,`size`);
--> statement-breakpoint
ALTER TABLE `app_settings` RENAME COLUMN `drive_storage_limit_bytes` TO `storage_limit_bytes`;
```

Append to `_journal.json` entries: `{ "idx": 72, "version": "6", "when": 1793347200000, "tag": "0080_storage_cap", "breakpoints": true }`.

- [ ] **Step 4: Write the PostgreSQL and MySQL migrations**

`drizzle/migrations-pg/0004_storage_cap.sql`:

```sql
ALTER TABLE "messages" ADD COLUMN "size" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_user_size_idx" ON "messages" ("user_id","size");--> statement-breakpoint
ALTER TABLE "app_settings" RENAME COLUMN "drive_storage_limit_bytes" TO "storage_limit_bytes";
```

`drizzle/migrations-mysql/0004_storage_cap.sql`:

```sql
ALTER TABLE `messages` ADD `size` bigint NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX `messages_user_size_idx` ON `messages` (`user_id`,`size`);--> statement-breakpoint
ALTER TABLE `app_settings` RENAME COLUMN `drive_storage_limit_bytes` TO `storage_limit_bytes`;
```

- [ ] **Step 5: Regenerate bundles and run the dialect test**

Run: `npm run db:bundle && node --test tests/database-dialects.test.mjs`
Expected: PASS; `git status` shows the two committed bundle files changed.

- [ ] **Step 6: Type-check the schema change**

Run: `npx tsc --noEmit 2>&1 | grep -E "driveStorageLimitBytes" `
Expected: exactly one error site, `src/app/api/admin/general/utils.ts` (fixed in Task 2). Any other file listed is a missed reference.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema/index.ts drizzle src/lib/migrations/bundle-postgres.json src/lib/migrations/bundle-mysql.json
git commit -m "feat(storage): add messages.size and rename the storage cap column"
```

---

### Task 2: Usage module, Drive callers and admin setting

**Files:**
- Create: `src/lib/storage/usage.ts`
- Delete: `src/lib/drive/storage.ts`
- Modify: `src/app/api/drive/upload/route.ts:54-55`
- Modify: `src/app/api/drive/items/route.ts:26`
- Modify: `src/app/api/admin/general/utils.ts`
- Modify: `src/app/(admin)/general/types.d.ts`
- Modify: `src/app/(admin)/general/page.tsx` (field `driveStorageLimitGb` → `storageLimitGb`)
- Modify: `src/lib/i18n/en.json` lines 1000-1004 (English values only)
- Test: `tests/storage-usage.test.mjs`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces, in `src/lib/storage/usage.ts`:

```ts
export type StorageUsage = { drive: number; mail: number; attachments: number; total: number };
export class StorageLimitError extends Error {
	readonly used: number; readonly limit: number; readonly requested: number;
	constructor(used: number, limit: number, requested: number); // message "Storage limit reached"
}
export async function getStorageLimit(env: CloudflareEnv): Promise<number | null>;
export async function getStorageUsage(db: AppDatabase, userId: string): Promise<StorageUsage>;
export async function getStorageUsageForUsers(db: AppDatabase, userIds: string[]): Promise<Map<string, StorageUsage>>;
export async function assertStorageAvailable(env: CloudflareEnv, db: AppDatabase, userId: string, additionalBytes: number): Promise<void>;
```

- `api/drive/items` response meta becomes `{ storageUsed: total, storageLimit, storageMail: mail + attachments, storageDrive: drive }`.
- `GET/PUT /api/admin/general` field is `storageLimitGb: number | null` (was `driveStorageLimitGb`).

- [ ] **Step 1: Write the failing usage test**

`tests/storage-usage.test.mjs`, entry exports `SqliteDatabase`, `applyMigrations`, `getDb` and everything from `./src/lib/storage/usage.ts`. Fixture inserts users `a` and `b`; for `a`: one `drive_items` file of 100 bytes, one trashed file of 50 bytes (`trashed_at` set), two `messages` of sizes 1000 and 200, one `message_attachments` row of 30 bytes on the first message with `trashed_at` set; for `b`: nothing. Set the cap with `INSERT INTO app_settings (id, storage_limit_bytes, updated_at) VALUES ('default', ?, 1)` where the test needs one.

```js
test("usage sums drive, mail and attachments including trashed rows", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await getStorageUsage(f.db, "a"), { drive: 150, mail: 1200, attachments: 30, total: 1380 });
	assert.deepEqual(await getStorageUsage(f.db, "b"), { drive: 0, mail: 0, attachments: 0, total: 0 });
});
test("usage for many users groups per user", async (t) => {
	const f = await fixture(t);
	const map = await getStorageUsageForUsers(f.db, ["a", "b", "missing"]);
	assert.equal(map.get("a").total, 1380);
	assert.equal(map.get("b").total, 0);
	assert.equal(map.get("missing").total, 0);
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
	await assertStorageAvailable(f.env, f.db, "a", 20);
	await assert.rejects(assertStorageAvailable(f.env, f.db, "a", 21), (error) => error instanceof StorageLimitError && error.message === "Storage limit reached" && error.used === 1380 && error.limit === 1400 && error.requested === 21);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/storage-usage.test.mjs`
Expected: FAIL, the esbuild entry cannot resolve `./src/lib/storage/usage.ts`.

- [ ] **Step 3: Implement `src/lib/storage/usage.ts`**

Three `select({ total: sql<number>\`coalesce(sum(...), 0)\` })` queries for one user; for many users the same three with `inArray` and `groupBy`, filling missing ids with zeros. `getStorageLimit` reads `appSettings.storageLimitBytes` for `id = "default"` and returns `null` unless `> 0`. `assertStorageAvailable` returns early on a null limit, else throws when `usage.total + additionalBytes > limit`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/storage-usage.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Replace the Drive-only module**

Delete `src/lib/drive/storage.ts`. In `api/drive/upload/route.ts` replace lines 54-55 with a `try { await assertStorageAvailable(env, db, ownerId, size); } catch (error) { if (error instanceof StorageLimitError) return NextResponse.json({ error: "Not enough storage left for this file" }, { status: 413 }); throw error; }`. In `api/drive/items/route.ts` line 26 build `meta` from `getStorageUsage(db, user.id)` and `getStorageLimit(env)` with the four keys above. In `api/admin/general/utils.ts` rename the zod key, `readSettings` key and `values.storageLimitBytes`, import from `@/lib/storage/usage`, and change the 400 message to `Enter a valid attachment limit (1 to 25 MB) or storage limit`. Rename the field in `types.d.ts` (comment: `Per-user storage cap in GB across mail and Drive; null when unlimited.`) and in `page.tsx`.

- [ ] **Step 6: Update the English copy**

In `en.json`: `general.drive` → `Storage`; `general.driveHint` → `Each user's mail, attachments and Drive files count toward their own limit. Uploads, sends and imports that would go over it are refused; incoming mail is always accepted and existing data is never removed.`; `general.driveSaved` → `Storage limit saved`.

- [ ] **Step 7: Type-check and lint**

Run: `npx tsc --noEmit 2>&1 | grep -E "drive/storage|driveStorageLimit|storageLimit|usage.ts"` then `npx eslint src/lib/storage/usage.ts src/app/api/drive src/app/api/admin/general "src/app/(admin)/general"`
Expected: no output from grep; eslint clean.

- [ ] **Step 8: Commit**

```bash
git add -A src/lib/storage/usage.ts src/lib/drive src/app/api/drive src/app/api/admin/general "src/app/(admin)/general" src/lib/i18n/en.json tests/storage-usage.test.mjs
git commit -m "feat(storage): combined per-user usage module replaces the Drive-only cap"
```

---

### Task 3: Record `messages.size` where raw MIME is written

**Files:**
- Modify: `src/lib/email/inbound.ts:191-215` (the `db.insert(messages).values({...})` call)
- Modify: `src/lib/import/service.ts:90-110`
- Modify: `src/lib/jmap/emails.ts` (`DraftRow`, `insertDraft`, and the `rawR2Key = await storeRawDraftMime(...)` site near line 407)
- Test: `tests/import-contact-failure.test.mjs` (existing fixture that calls `importMessagesToMailbox`), new `tests/storage-size-write.test.mjs`

**Interfaces:**
- Consumes: `messages.size` from Task 1.
- Produces: every stored raw MIME object has its byte length in `messages.size`; messages without a raw object keep 0.

- [ ] **Step 1: Write the failing test**

`tests/storage-size-write.test.mjs`, built on the fixture style of `tests/import-contact-failure.test.mjs` (copy its env with the in-memory bucket):

```js
test("import records the raw byte length in messages.size", async (t) => {
	const f = await fixture(t);
	const raw = new TextEncoder().encode("From: a@one.test\r\nTo: sam@one.test\r\nSubject: hi\r\n\r\nbody").buffer;
	await importMessagesToMailbox(f.env, { userId: f.userId, mailboxId: f.mailboxId, destination: f.destination, messages: [{ filename: "a.eml", raw }] });
	assert.equal(f.database.db.prepare("SELECT size FROM messages").get().size, raw.byteLength);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/storage-size-write.test.mjs`
Expected: FAIL, `size` is 0.

- [ ] **Step 3: Set the size at the three write sites**

`inbound.ts`: add `size: buffer.byteLength,` next to `rawR2Key: payload.rawR2Key`. `import/service.ts`: add `size: input.raw.byteLength,` next to `rawR2Key`. `jmap/emails.ts`: add `size?: number` to `DraftRow`, insert `size: row.size ?? 0`, and wherever `rawR2Key` is written to the row after `storeRawDraftMime(ctx, id, upload.content)` also write `size: upload.content.byteLength` (insert or update, whichever that code path uses).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/storage-size-write.test.mjs tests/import-contact-failure.test.mjs tests/inbound-hardening.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/inbound.ts src/lib/import/service.ts src/lib/jmap/emails.ts tests/storage-size-write.test.mjs
git commit -m "feat(storage): record raw MIME size on inbound, import and JMAP drafts"
```

---

### Task 4: Enforce the cap on send and import

**Files:**
- Modify: `src/lib/email/send.ts` (inside `sendEmail`, after `validateAttachments`)
- Modify: `src/app/api/send/error-utils.ts`
- Modify: `src/lib/email/auto-reply.ts`, `src/app/api/calendar/events/route.ts`, `src/app/api/calendar/events/[eventId]/route.ts` (only where `sendEmail` is called without a `try`)
- Modify: `src/lib/import/service.ts` (`importMessageToMailbox` before the insert; `importMessagesToMailbox` loop)
- Test: `tests/storage-enforcement.test.mjs`

**Interfaces:**
- Consumes: `assertStorageAvailable`, `StorageLimitError` from Task 2; `importMessagesToMailbox(env, { userId, mailboxId, destination, messages })` from `src/lib/import/service.ts`.
- Produces: `sendEmail` rejects with `StorageLimitError` when over the cap; `getSendErrorStatus("Storage limit reached. Delete mail or files to send.")` is `413`; `importMessagesToMailbox` rethrows `StorageLimitError` instead of counting it as a skipped message, so `src/lib/import/jobs.ts` (unchanged) marks the job `failed` with `error = "Storage limit reached"` and leaves the cursor.

- [ ] **Step 1: Write the failing tests**

`tests/storage-enforcement.test.mjs`, fixture as in Task 3 plus `app_settings` with `storage_limit_bytes = 1000` and a user whose usage is already 1000 (one `messages` row of size 1000):

```js
test("sendEmail refuses when the user is at the cap, even without attachments", async (t) => {
	const f = await fixture(t);
	await assert.rejects(sendEmail(f.env, { userId: f.userId, mailboxId: f.mailboxId, from: "sam@one.test", to: ["x@two.test"], subject: "s", text: "t" }), (error) => error instanceof StorageLimitError);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM messages WHERE direction = 'outbound'").get().n, 0);
});
test("getSendErrorStatus maps the storage message to 413", () => {
	assert.equal(getSendErrorStatus("Storage limit reached. Delete mail or files to send."), 413);
});
test("import stops at the cap, keeps earlier messages and rethrows", async (t) => {
	const f = await fixture(t, { limit: 1200, used: 1000 });
	const small = rawOf(100), big = rawOf(300);
	await assert.rejects(importMessagesToMailbox(f.env, { userId: f.userId, mailboxId: f.mailboxId, destination: f.destination, messages: [{ filename: "1.eml", raw: small }, { filename: "2.eml", raw: big }] }), (error) => error instanceof StorageLimitError);
	assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key LIKE 'imports/%'").get().n, 1);
});
```

Where `sendEmail`'s input shape differs from the literal above, use the real `SendEmailInput` fields; the assertion is that it rejects before storing anything.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/storage-enforcement.test.mjs`
Expected: FAIL on all three.

- [ ] **Step 3: Implement**

`send.ts`: after `validateAttachments(attachments)`, `await assertStorageAvailable(env, db, input.userId, attachments.reduce((n, a) => n + a.content.byteLength, 0))`; let `StorageLimitError` propagate unchanged (its message stays `Storage limit reached`). `error-utils.ts`: add `if (message.startsWith("Storage limit reached")) return 413;` as the first line of `getSendErrorStatus`. In the `catch` of `api/send/route.ts` (line 56), `api/v1/send/route.ts` and `api/messages/[messageId]/send-now/route.ts`: when `err instanceof StorageLimitError`, respond `NextResponse.json({ error: "Storage limit reached. Delete mail or files to send." }, { status: 413 })` before the generic mapping. Auto-reply and calendar callers: wrap the `sendEmail` call in `try/catch` that logs `console.warn("Storage limit reached; skipped automatic send", { userId })` and continues. `import/service.ts`: in `importMessageToMailbox` call `assertStorageAvailable(env, db, input.userId, input.raw.byteLength)` before the insert; in the loop's `catch`, `if (error instanceof StorageLimitError) throw error;` before the skip logic.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/storage-enforcement.test.mjs tests/import-contact-failure.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/send.ts src/app/api/send src/lib/email/auto-reply.ts src/app/api/calendar src/lib/import/service.ts tests/storage-enforcement.test.mjs
git commit -m "feat(storage): enforce the cap on send and import"
```

---

### Task 5: Show usage to users and admins

**Files:**
- Modify: `src/app/(drive)/drive-events.ts` (`DriveStorageDetail`)
- Modify: `src/app/(drive)/drive/page.tsx:98`
- Modify: `src/app/(drive)/drive-nav.tsx:188-197`
- Modify: `src/app/api/accounts/route.ts` (GET), `src/app/api/accounts/types.d.ts`
- Modify: `src/app/(admin)/accounts/types.d.ts`, `accounts-table-types.d.ts`, `accounts-table.tsx`, `page.tsx`
- Modify: `src/lib/i18n/en.json` (new keys `drive.storageBreakdown`, `accounts.colStorage`)
- Test: `tests/accounts-storage.test.mjs`

**Interfaces:**
- Consumes: `api/drive/items` meta `{ storageUsed, storageLimit, storageMail, storageDrive }` from Task 2; `getStorageUsageForUsers`, `getStorageLimit` from Task 2; `formatDriveSize(bytes)` from `src/lib/drive/utils.ts`.
- Produces: `DriveStorageDetail = { used: number; limit: number | null; mail: number; drive: number }`; `GET /api/accounts` items gain `storageUsed: number` and the response gains `storageLimit: number | null`.

- [ ] **Step 1: Write the failing accounts test**

`tests/accounts-storage.test.mjs`, fixture from `tests/account-alias-selection.test.mjs` with a session, plus one `messages` row of size 700 and one `drive_items` row of 300 for user `admin`, and `app_settings.storage_limit_bytes = 5000`:

```js
test("accounts list reports storage per user and the limit", async (t) => {
	const f = await fixture(t);
	const response = await accountsGet(new Request("https://mailflare.test/api/accounts", { headers: { Authorization: `Bearer ${f.session}` } }));
	const body = await response.json();
	assert.equal(body.storageLimit, 5000);
	assert.equal(body.accounts.find((a) => a.id === "admin").storageUsed, 1000);
	assert.equal(body.accounts.find((a) => a.id === "other").storageUsed, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/accounts-storage.test.mjs`
Expected: FAIL, `storageLimit` undefined.

- [ ] **Step 3: Implement the API and UI**

`api/accounts/route.ts` GET: `const usage = await getStorageUsageForUsers(db, rows.map((row) => row.id))`, add `storageUsed: usage.get(row.id)?.total ?? 0` to each item and `storageLimit: await getStorageLimit(access.env)` to the response. Add `storageUsed?: number` to `AccountListItem` and the admin `Account` type, `storageLimit?: number | null` to `AccountListResponse`. `accounts-table.tsx`: new header `t("accounts.colStorage")` and a cell `formatDriveSize(account.storageUsed ?? 0)` with `text-red-600` when `storageLimit && (account.storageUsed ?? 0) >= storageLimit`; `AccountsTableProps` gains `storageLimit: number | null`, passed from `page.tsx`. Keep the column hidden below `md` like the others and widen the row grid template by one column. Drive: extend `DriveStorageDetail`, dispatch `mail: data.storageMail, drive: data.storageDrive` on page.tsx line 98, and in `drive-nav.tsx` add `<p className="text-xs text-neutral-500">{t("drive.storageBreakdown", { mail: formatDriveSize(storage.mail), drive: formatDriveSize(storage.drive) })}</p>` under the "X of Y" line (and under the unlimited line). `en.json`: `"drive.storageBreakdown": "Mail {mail} · Drive {drive}"`, `"accounts.colStorage": "Storage"`.

- [ ] **Step 4: Run the test, type-check and lint**

Run: `node --test tests/accounts-storage.test.mjs && npx eslint "src/app/(drive)" "src/app/(admin)/accounts" src/app/api/accounts`
Expected: PASS; eslint clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(drive)" "src/app/(admin)/accounts" src/app/api/accounts src/lib/i18n/en.json tests/accounts-storage.test.mjs
git commit -m "feat(storage): show combined usage in Drive and the admin accounts list"
```

---

### Task 6: AWS deployment files

**Files:**
- Create: `deploy/aws/README.md`, `deploy/aws/docker-compose.aws.yml`, `deploy/aws/Caddyfile`, `deploy/aws/.env.aws.example`, `deploy/aws/iam-policy.json`, `deploy/aws/s3-lifecycle.json`, `deploy/aws/bootstrap.sh`, `deploy/aws/DNS-RECORDS.md`

**Interfaces:**
- Consumes: the spec's Part 1 table verbatim; the root `Dockerfile` and `docker-compose.yml`; the env reference in `docs/self-hosting.md` and `.env.docker.example`.
- Produces: a runbook a person can follow top to bottom on a fresh Ubuntu 24.04 EC2 instance.

- [ ] **Step 1: Write the compose file and Caddyfile**

`docker-compose.aws.yml`: service `mailflare` built from the repo root (`build: ../..`), `env_file: .env.aws`, ports `25:25` only, volume `mailflare-data:/data`, `restart: unless-stopped`; service `caddy` from `caddy:2`, ports `80:80` and `443:443`, volumes for `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy-data:/data`, `caddy-config:/config`, `depends_on: mailflare`. `Caddyfile`: site `mail.carsens.co` with `reverse_proxy mailflare:3000` (Caddy proxies WebSockets without extra config) and `encode gzip`.

- [ ] **Step 2: Write the env example**

`.env.aws.example` with every key from the spec, real placeholders, and a comment per key: `APP_URL=https://mail.carsens.co`, `MAIL_HOSTNAME=mail.carsens.co`, `SMTP_INBOUND_PORT=25`, `SMTP_URL=smtps://SES_SMTP_USER:SES_SMTP_PASSWORD@email-smtp.REGION.amazonaws.com:465`, `S3_BUCKET=`, `S3_REGION=`, `S3_ACCESS_KEY_ID=`, `S3_SECRET_ACCESS_KEY=`, `SMTP_MAX_SIZE` left default, plus commented optional `VAPID_*` and `AI_*` lines.

- [ ] **Step 3: Write the IAM policy, lifecycle rule and bootstrap script**

`iam-policy.json`: two statements, bucket-level `s3:ListBucket` on `arn:aws:s3:::BUCKET_NAME` and object-level `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` on `arn:aws:s3:::BUCKET_NAME/*`; a third statement `ses:SendEmail`, `ses:SendRawEmail` on `*`. `s3-lifecycle.json`: one rule `abort-incomplete-multipart` with `AbortIncompleteMultipartUpload.DaysAfterInitiation = 7`, status Enabled, empty filter. `bootstrap.sh` (`set -euo pipefail`): apt install docker.io docker-compose-v2 git; add `ubuntu` to the docker group; `git clone --branch storage-cap <FORK_URL> /opt/mailflare`; copy `.env.aws.example` to `.env.aws` if absent and stop with a message to edit it; `docker compose -f deploy/aws/docker-compose.aws.yml up -d --build`.

- [ ] **Step 4: Write DNS-RECORDS.md and README.md**

`DNS-RECORDS.md`: one table per domain (carsens.co, netfo.co) with Type, Name, Value, TTL columns for the records in the spec, `ELASTIC_IP` and the three `DKIM_TOKEN_n` as placeholders, and a note that MX for both domains points at `mail.carsens.co`. `README.md` runbook in this order: 1 S3 bucket (private, block public access, lifecycle), 2 IAM user and keys, 3 SES domain verification for both domains and the DKIM CNAMEs, 4 SES SMTP credentials, 5 SES production access request, 6 EC2 instance, security group, Elastic IP, 7 DNS records, 8 run bootstrap.sh and edit `.env.aws`, 9 open `https://mail.carsens.co/setup`, create the admin, add both domains, set the storage limit to 1000 GB on Admin › General, 10 send a test mail each way, 11 EBS snapshot schedule. Each step says what to copy where.

- [ ] **Step 5: Validate the files**

Run: `bash -n deploy/aws/bootstrap.sh && node -e "for (const f of ['iam-policy.json','s3-lifecycle.json']) JSON.parse(require('fs').readFileSync('deploy/aws/'+f,'utf8'))" && (docker compose -f deploy/aws/docker-compose.aws.yml config >/dev/null 2>&1 || node -e "require('js-yaml')" 2>/dev/null || echo "compose syntax not checked: docker unavailable")`
Expected: no errors; if docker is unavailable the echo line prints and the YAML is reviewed by eye.

- [ ] **Step 6: Commit**

```bash
git add deploy/aws
git commit -m "docs(deploy): AWS EC2, S3 and SES deployment files"
```

---

### Task 7: Merge and verify

**Files:** none new.

- [ ] **Step 1: Merge the four worktree branches into `storage-cap`** in the order 3, 4, 5, 6; resolve any `en.json` or `import/service.ts` overlap by keeping both sides' lines.

- [ ] **Step 2: Run everything**

Run: `node --test tests/*.test.mjs && npm run lint && npx tsc --noEmit`
Expected: all tests pass; lint and type check report nothing for files touched by this plan (pre-existing type errors elsewhere are listed, not fixed).

- [ ] **Step 3: Build the Node bundle once**

Run: `npm run build:node`
Expected: exits 0.

- [ ] **Step 4: Update the spec status line** to `Status: implemented on branch storage-cap` and commit.
