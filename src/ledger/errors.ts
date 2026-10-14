export class LedgerError extends Error {
  override readonly name: string = "LedgerError";
}

/** The database was written by a newer Switchboard, or its applied migrations do not match this build. */
export class MigrationError extends LedgerError {
  override readonly name = "MigrationError";
}

/** A `decision` was refused: the run is unknown or already terminal (LLD §15.3 ordering rule, T5.3). */
export class DecisionRefusedError extends LedgerError {
  override readonly name = "DecisionRefusedError";
}
