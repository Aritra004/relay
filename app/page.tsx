import { Workspace } from "@/components/workspace/workspace";
import { WorkspaceProvider } from "@/components/workspace/workspace-provider";

export default function Home() {
  return <WorkspaceProvider><Workspace /></WorkspaceProvider>;
}
