# Combined per-user storage cap and AWS deployment

Date: 2026-11-01
Status: implemented on branch `storage-cap` (2026-11-01). Tests, type check, lint and the Node build pass; the AWS steps in `deploy/aws/README.md` are still to be run by the owner.

## Goal

Run Mailflare for the owner's own team on the domains carsens.co and netfo.co, self-hosted in Docker on an EC2 instance, with Amazon S3 for blobs and Amazon SES for outbound mail. Every user gets Inbox, Calendar, Booking and Drive. Each user has one storage cap, 1 TB, that counts mail and Drive together.

Out of scope: billing, self-service signup, tenant separation, per-user limit overrides, a hard SMTP rejection of inbound mail when a user is full.

## Part 1: deployment on AWS (no application code changes)

| Piece | Decision |
|---|---|
| Source | This fork, branch `storage-cap`. Upstream stays as a git remote for later merges. The Docker image is built from the fork. |
| Compute | One EC2 instance (2 vCPU, 8 GB), Elastic IP, Docker Engine with Compose. Security group allows inbound 25, 80, 443. |
| HTTPS | Caddy in front of the container. Public address `https://mail.carsens.co`; netfo.co users sign in at the same address. `APP_URL` is set to it. Caddy also forwards WebSocket upgrades on `/api/realtime`. |
| Blobs | One private S3 bucket for raw mail, attachments, Drive files, avatars, branding and backups. Configured with `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. A lifecycle rule aborts incomplete multipart uploads after 7 days. |
| Database | SQLite in the `/data` volume (default). |
| Outbound | SES as an SMTP relay through `SMTP_URL` using SES SMTP credentials on port 465. Both domains verified in SES with DKIM. Production access requested before go-live. |
| Inbound | Built-in SMTP listener on port 25 (`MAIL_HOSTNAME=mail.carsens.co`). MX of both domains points at the instance. |
| DNS per domain | `A mail.<domain>` to the Elastic IP; `MX @ 10 mail.<domain>`; `TXT @ "v=spf1 include:amazonses.com -all"`; three SES DKIM CNAMEs; `TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>"`. Without `CF_TOKEN` Mailflare records the zone as manually managed and lists the records to set. |
| IAM | One IAM user with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` on `arn:aws:s3:::<bucket>/*` and `s3:ListBucket` on the bucket, plus `ses:SendEmail`, `ses:SendRawEmail`. SES SMTP credentials are generated from a separate IAM user restricted to `ses:SendRawEmail`. |
| Backups | Mailflare's daily backup (02:00 UTC) writes to the bucket. An EBS snapshot schedule (daily, keep 14) covers the SQLite file. |
| Deliverables | `deploy/aws/`: `README.md` (ordered runbook), `docker-compose.aws.yml` (app plus Caddy), `Caddyfile`, `.env.aws.example`, `iam-policy.json`, `s3-lifecycle.json`, `bootstrap.sh` (Ubuntu 24.04: install Docker, clone the fork, build, start), `DNS-RECORDS.md` with the records for both domains. |

Cost note recorded for the owner: S3 Standard is roughly $23 per TB-month, so the cap is also the per-user ceiling on the S3 bill.

## Part 2: combined storage cap (application changes)

### Current behaviour

- `app_settings.drive_storage_limit_bytes` is one global cap. The admin General page edits it in GB (`driveStorageLimitGb`); the English label already reads "Storage limit per user (GB)".
- `src/lib/drive/storage.ts` exposes `getDriveStorageLimit(env)` and `getDriveStorageUsed(db, ownerId)`, which sums `drive_items.size`. Used by `src/app/api/drive/upload/route.ts` (413 when exceeded), `src/app/api/drive/items/route.ts` (meta for the sidebar meter) and `src/app/api/admin/general/utils.ts`.
- Mail: `messages.user_id` identifies the owner. Raw MIME is stored in the bucket under `messages.raw_r2_key` by the inbound path (`src/lib/email/inbound.ts`), the import path (`src/lib/import/service.ts`, key `imports/<id>.eml`) and JMAP drafts when a blob is supplied (`src/lib/jmap/emails.ts`). Sent mail (`src/lib/email/send.ts`) stores no raw MIME; its attachments are stored through `storeMessageAttachments`. Every attachment is a row in `message_attachments` with `size` and its own bucket object. `deleteMessageWithObjects` removes raw, attachments and the row together.
- Messages have no recorded raw size.

### Definition of usage

For a user, `used = drive + mail + attachments` where

- `drive` = `SUM(drive_items.size)` for `owner_id = user`
- `mail` = `SUM(messages.size)` for `user_id = user` (new column: bytes of the raw MIME object, 0 when none is stored)
- `attachments` = `SUM(message_attachments.size)` joined through `messages.user_id = user`

This equals the bytes the user occupies in the bucket. Attachments are counted both inside the raw message and as extracted objects because both objects exist. Bodies stored in the database are not counted. Trashed items still count until purged.

### Schema and migrations

- `messages.size INTEGER NOT NULL DEFAULT 0`, plus index `messages_user_size_idx (user_id, size)` so the per-user sum is index-only.
- Rename `app_settings.drive_storage_limit_bytes` to `storage_limit_bytes`; Drizzle field `storageLimitBytes`.
- Migrations: SQLite `drizzle/migrations/0080_storage_cap.sql` with a `_journal.json` entry (idx 72); PostgreSQL `drizzle/migrations-pg/0004_storage_cap.sql`; MySQL `drizzle/migrations-mysql/0004_storage_cap.sql`. Regenerate the bundles with `npm run db:bundle`. `tests/database-dialects.test.mjs` must pass.
- Existing rows get `size = 0`. This deployment starts empty, so no backfill job is built. A later reconcile (HEAD each raw object) is noted as a possible follow-up, not built now.

### Usage module

New `src/lib/storage/usage.ts`, replacing `src/lib/drive/storage.ts` (deleted, callers updated):

```ts
export type StorageUsage = { drive: number; mail: number; attachments: number; total: number };
export async function getStorageLimit(env: CloudflareEnv): Promise<number | null>;
export async function getStorageUsage(db: AppDatabase, userId: string): Promise<StorageUsage>;
/** Three grouped queries; for the admin accounts list. */
export async function getStorageUsageForUsers(db: AppDatabase, userIds: string[]): Promise<Map<string, StorageUsage>>;
export class StorageLimitError extends Error { readonly used: number; readonly limit: number; readonly requested: number; }
/** Resolves when `additionalBytes` fits under the cap (or there is no cap); otherwise throws StorageLimitError. */
export async function assertStorageAvailable(env: CloudflareEnv, db: AppDatabase, userId: string, additionalBytes: number): Promise<void>;
```

### Writing `messages.size`

| Path | Value |
|---|---|
| `src/lib/email/inbound.ts` (the single `db.insert(messages)` call) | `buffer.byteLength` of the raw object just read |
| `src/lib/import/service.ts` | `input.raw.byteLength` |
| `src/lib/jmap/emails.ts` `insertDraft` | the blob's byte length when `rawR2Key` is set, else 0 |
| `send.ts`, drafts, templates, agent tools, seed | column default 0 (no raw object) |

### Enforcement

| Point | Behaviour |
|---|---|
| Drive upload (`api/drive/upload`) | `assertStorageAvailable(user, size)`; 413 with "Not enough storage left for this file" (existing behaviour, now against the combined total). |
| Sending (`sendEmail` in `src/lib/email/send.ts`) | Before storing, `assertStorageAvailable(user, sum of attachment sizes)`. `StorageLimitError` propagates; `api/send`, `api/v1/send` and the scheduled send route map it to 413 with "Storage limit reached. Delete mail or files to send." Auto-reply and calendar-invite callers catch it and log, so they never crash a request. |
| Imports (`src/lib/import/jobs.ts`) | Before each message, `assertStorageAvailable(user, raw.byteLength)`. On `StorageLimitError` the job is marked `failed` with `error = "Storage limit reached"`; the cursor is kept so a later run can resume. |
| Inbound mail | Always accepted. No check. |

### Visibility

- `api/drive/items` meta becomes `{ storageUsed, storageLimit, storageMail, storageDrive }` where `storageMail = mail + attachments`. `DriveStorageDetail` gains `mail` and `drive`. The Drive sidebar keeps the bar and the "X of Y" line and adds one small line "Mail X · Drive Y".
- Admin Accounts list: `api/accounts` returns `storageUsed` per user via `getStorageUsageForUsers`; the table gains a "Storage" column (formatted with `formatDriveSize`), red when at or above the limit.
- Admin General page: `driveStorageLimitGb` becomes `storageLimitGb` in the API, types and page; the hint text says the cap counts mail, attachments and Drive files. The Drive card title becomes "Storage".
- New strings are added to `src/lib/i18n/en.json`; other locales fall back to English until translated.

### Error handling

- A missing or zero limit means unlimited everywhere.
- The usage queries run inside the existing request; a database error surfaces as the route's normal 500.
- `assertStorageAvailable` is evaluated before any object is written, so a rejected request leaves no orphaned blobs.

### Testing

`node --test tests/*.test.mjs` style, following `tests/account-alias-selection.test.mjs` (esbuild bundle, `SqliteDatabase`, `applyMigrations`):

- `tests/storage-usage.test.mjs`: usage across the three tables; empty user is 0; null limit is unlimited; `assertStorageAvailable` throws exactly at the boundary; `getStorageUsageForUsers` groups correctly.
- `tests/storage-enforcement.test.mjs`: drive upload returns 413 over cap; `sendEmail` throws `StorageLimitError` over cap and succeeds under it; import job fails with the reason and keeps its cursor.
- `tests/database-dialects.test.mjs` continues to pass with the new migrations and bundles.
- `npx tsc --noEmit` and `npm run lint` clean for touched files.

### Work breakdown for parallel execution

1. Foundation (sequential, first): schema, migrations, bundles, usage module and its tests, delete the Drive-only module and fix its three callers.
2. Parallel after 1, each in its own worktree branched from `storage-cap`:
   - A. Write sites: set `messages.size` in inbound, import and JMAP paths.
   - B. Enforcement: send, import job, route error mapping, enforcement tests.
   - C. Visibility: Drive meta and sidebar, admin accounts column, admin general rename, i18n keys.
   - D. AWS deployment files under `deploy/aws/` (independent of the code; may start immediately).
3. Merge A to D into `storage-cap`, run the full test suite, lint and type check.
