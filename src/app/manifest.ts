import type { MetadataRoute } from "next";
import { getHomeBranding } from "./home-server-utils";

export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
	const { appName } = await getHomeBranding();
	return {
		name: appName,
		short_name: appName,
		description: "Email, anywhere.",
		id: "/",
		scope: "/",
		start_url: "/inbox",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#ffffff",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
		],
	};
}
