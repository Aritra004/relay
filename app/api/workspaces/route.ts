import { requireUser } from "@/server/auth/session";
import { apiResponse, assertSameOrigin, json, readJson } from "@/server/http/response";
import { createWorkspace, listWorkspaces } from "@/server/workspaces/service";

export const runtime = "nodejs";
export async function GET() {
  return apiResponse(async () => {
    const user = await requireUser();
    return json({ workspaces: await listWorkspaces(user.id) });
  });
}

export async function POST(request: Request) {
  return apiResponse(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    return json(await createWorkspace(user.id, await readJson(request)), 201);
  });
}
