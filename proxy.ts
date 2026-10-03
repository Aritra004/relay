import { auth } from "@/server/auth/auth";

export default auth.middleware({ loginUrl: "/auth/sign-in" });
// Workspace pages are data-free shells that must load without an auth round trip.
// Every workspace API request still verifies session and membership on the server.
export const config = { matcher: ["/account/:path*"] };
