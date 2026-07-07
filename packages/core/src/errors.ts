export function normalizeSqliteError(error: unknown): Error {
  if (!isNodeError(error)) {
    return new Error(messageFromError(error));
  }

  if (error.message.toLowerCase().includes("foreign key")) {
    return new Error(`SQLite foreign key constraint failed: ${error.message}`);
  }

  return error;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
