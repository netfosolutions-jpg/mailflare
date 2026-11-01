import type { Account } from "./types";

export type AccountsTableProps = {
	accounts: Account[];
	currentUserId?: string;
	isPrimaryAdmin: boolean;
	/** Per-user storage cap in bytes; null means unlimited, so no usage is flagged. */
	storageLimit: number | null;
	loading: boolean;
	selected: Set<string>;
	onSelectedChange: (selected: Set<string>) => void;
	onDeleteSelected: () => void;
	onRestore: (account: Account) => void;
	restoringId: string | null;
};

export type DeleteAccountsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accounts: Account[];
	candidates: Account[];
	onDeleted: () => void;
};
