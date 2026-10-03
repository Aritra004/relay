export class InvalidLocalDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLocalDataError";
  }
}

export function describeStorageError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "QuotaExceededError":
      return "Local storage is full. Free some device space, then retry. Keep this tab open: unsaved changes are only in memory.";
    case "BlockedError":
      return "Local storage is blocked by another Relay tab. Close other Relay tabs, then retry.";
    case "MissingAPIError":
    case "SecurityError":
    case "InvalidStateError":
      return "This browser cannot access local storage. Allow site storage, then retry.";
    case "InvalidLocalDataError":
    case "SchemaError":
    case "UpgradeError":
    case "VersionError":
      return "Stored workspace data is invalid or uses an unsupported version. Relay has kept the stored data and pending queue untouched. Open a compatible version of Relay to recover it.";
    case "StaleWorkspaceError":
      return "Another tab changed this workspace. Your unsaved edits are kept in this tab. Download them before reloading to load the latest stored workspace.";
    case "AbortError":
    case "DatabaseClosedError":
      return "The local write was interrupted. Keep this tab open and retry saving. The last completed write is still stored.";
    default:
      return "Relay could not safely store or restore your workspace. Keep this tab open and retry. Existing stored data and pending operations have not been cleared.";
  }
}
