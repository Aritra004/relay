import { OfflineWorkspaces } from "@/components/account/offline-workspaces";

// Public, data-free shell. Private workspace data only comes from an authorized
// API response or the current account's previously authorized IndexedDB cache.
export default function OfflinePage() { return <OfflineWorkspaces />; }
