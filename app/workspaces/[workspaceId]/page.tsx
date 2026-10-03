import { OnlineWorkspace } from "@/components/account/online-workspace";
export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <OnlineWorkspace key={workspaceId} workspaceId={workspaceId} />;
}
