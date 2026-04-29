import { DatabaseSync } from "node:sqlite";

export type DbClient = {
  db: DatabaseSync;
  transaction<T>(fn: () => T): T;
};

export function openDatabase(path: string): DbClient {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  return {
    db,
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const result = fn();
        db.exec("COMMIT;");
        return result;
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    },
  };
}

