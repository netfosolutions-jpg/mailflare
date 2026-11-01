import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getEnv } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

/**
 * The mail app is the front door: a signed-in visitor lands in the inbox, anyone else on the
 * login page (or the setup wizard before the first account exists), like the login page itself
 * decides. If the database cannot answer yet, the inbox's own auth guard sorts it out.
 */
export default async function HomePage() {
	redirect(await homeDestination());
}

async function homeDestination(): Promise<string> {
	try {
		const env = getEnv();
		if (!(await hasAdminAccount(env))) return "/setup";
		const user = await getUserFromSession(env, (await cookies()).get(SESSION_COOKIE)?.value);
		return user && !user.disabled ? "/inbox" : "/login";
	} catch {
		return "/inbox";
	}
}
