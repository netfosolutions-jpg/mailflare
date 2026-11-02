/** Shared inboxes are always available on this self-hosted build (see SELF_HOSTED_LICENSE in the licenses service). */
export async function isTeamMailboxSharingEnabled(): Promise<boolean> {
	return true;
}
