/** What the send routes answer with, alongside 413, when the sender's storage cap refuses the Sent copy. */
export const STORAGE_LIMIT_SEND_ERROR = "Storage limit reached. Delete mail or files to send.";

export function getSendErrorStatus(message: string): number {
	if (message.startsWith("Storage limit reached")) return 413;
	if (message === "Mailbox is required") return 400;
	if (message.startsWith("Attachments exceed") || message.startsWith("Subject exceeds") || message.startsWith("Headers exceed") || message.startsWith("Message exceeds Cloudflare") || message.startsWith("A message can include at most") || message.includes("exceeds the 25 MB attachment limit")) return 400;
	if (
		message === "Mailbox not found" ||
		message === "Sender account not found" ||
		message === "You do not have permission to send from this mailbox" ||
		message === "Sender address does not match the selected mailbox"
	) {
		return 403;
	}
	return 500;
}
