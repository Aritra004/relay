import { requireUser } from "@/server/auth/session";
import { apiResponse, json } from "@/server/http/response";

export const runtime = "nodejs";
export async function GET() {
  return apiResponse(async () => {
    const user = await requireUser();
    return json({ user: { id: user.id, name: user.name, email: user.email } });
  });
}
