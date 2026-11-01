import { eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { appSettings, driveItems, messageAttachments, messages } from "@/db/schema";

/** Bytes a user occupies in the bucket: Drive files, raw mail and extracted attachments. */
export type StorageUsage = { drive: number; mail: number; attachments: number; total: number };

/** Thrown when a write would take a user past the storage cap. `message` is always "Storage limit reached". */
export class StorageLimitError extends Error {
	readonly used: number;
	readonly limit: number;
	readonly requested: number;

	constructor(used: number, limit: number, requested: number) {
		super("Storage limit reached");
		this.name = "StorageLimitError";
		this.used = used;
		this.limit = limit;
		this.requested = requested;
	}
}

/** Per-user storage cap in bytes across mail, attachments and Drive, or null for unlimited. Set by the admin on the General page. */
export async function getStorageLimit(env: CloudflareEnv): Promise<number | null> {
	const [settings] = await getDb(env).select({ limit: appSettings.storageLimitBytes }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
	return settings?.limit && settings.limit > 0 ? settings.limit : null;
}

const sumOf = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)`;

function usageOf(drive: number, mail: number, attachments: number): StorageUsage {
	return { drive, mail, attachments, total: drive + mail + attachments };
}

export async function getStorageUsage(db: AppDatabase, userId: string): Promise<StorageUsage> {
	const [drive] = await db.select({ total: sumOf(driveItems.size) }).from(driveItems).where(eq(driveItems.ownerId, userId));
	const [mail] = await db.select({ total: sumOf(messages.size) }).from(messages).where(eq(messages.userId, userId));
	const [attachments] = await db
		.select({ total: sumOf(messageAttachments.size) })
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(eq(messages.userId, userId));
	return usageOf(Number(drive?.total ?? 0), Number(mail?.total ?? 0), Number(attachments?.total ?? 0));
}

/** Usage for many users in three grouped queries; ids with nothing stored map to zeros. */
export async function getStorageUsageForUsers(db: AppDatabase, userIds: string[]): Promise<Map<string, StorageUsage>> {
	const result = new Map<string, StorageUsage>(userIds.map((id) => [id, usageOf(0, 0, 0)]));
	if (!userIds.length) return result;
	const drive = await db.select({ userId: driveItems.ownerId, total: sumOf(driveItems.size) }).from(driveItems).where(inArray(driveItems.ownerId, userIds)).groupBy(driveItems.ownerId);
	const mail = await db.select({ userId: messages.userId, total: sumOf(messages.size) }).from(messages).where(inArray(messages.userId, userIds)).groupBy(messages.userId);
	const attachments = await db
		.select({ userId: messages.userId, total: sumOf(messageAttachments.size) })
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(inArray(messages.userId, userIds))
		.groupBy(messages.userId);
	const apply = (rows: { userId: string; total: number }[], key: "drive" | "mail" | "attachments") => {
		for (const row of rows) {
			const usage = result.get(row.userId);
			if (usage) usage[key] = Number(row.total ?? 0);
		}
	};
	apply(drive, "drive");
	apply(mail, "mail");
	apply(attachments, "attachments");
	for (const usage of result.values()) usage.total = usage.drive + usage.mail + usage.attachments;
	return result;
}

/** Resolves when `additionalBytes` still fits under the user's cap (or there is no cap); otherwise throws StorageLimitError. */
export async function assertStorageAvailable(env: CloudflareEnv, db: AppDatabase, userId: string, additionalBytes: number): Promise<void> {
	const limit = await getStorageLimit(env);
	if (limit === null) return;
	const usage = await getStorageUsage(db, userId);
	if (usage.total + additionalBytes > limit) throw new StorageLimitError(usage.total, limit, additionalBytes);
}
