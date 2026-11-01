import type { Branding } from "@/lib/branding/types";
import { DEFAULT_APP_NAME } from "@/lib/branding/defaults";

export const DEFAULT_BRANDING: Branding = {
	appName: DEFAULT_APP_NAME,
	hasCustomIcon: false,
	canCustomizeBranding: false,
};

/** True while an installation shows the packaged name and icon, so UI may use the full wordmark. */
export function usesDefaultBrand(branding: Pick<Branding, "appName" | "hasCustomIcon">): boolean {
	return !branding.hasCustomIcon && branding.appName === DEFAULT_APP_NAME;
}

export async function fetchBranding(): Promise<Branding> {
	const response = await fetch("/api/branding", { cache: "no-store" });
	if (!response.ok) return DEFAULT_BRANDING;
	return (await response.json()) as Branding;
}
