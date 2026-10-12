export class LedgerError extends Error {
  override readonly name: string = "LedgerError";
}

/** The database was written by a newer Switchboard, or its applied migrations do not match this build. */
export class MigrationError extends LedgerError {
  override readonly name = "MigrationError";
}
