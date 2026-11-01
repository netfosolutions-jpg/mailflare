export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	/** Per-user storage cap in GB across mail, attachments and Drive; null when unlimited. */
	storageLimitGb: number | null;
}
