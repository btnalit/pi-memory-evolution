import { createRequire } from "node:module";
import { BUSY_TIMEOUT_MS } from "./limits.ts";

/** Pi's standalone binary uses Bun; npm Pi and tests use Node. Both bundle SQLite. */
const require = createRequire(import.meta.url);
export type Database = import("node:sqlite").DatabaseSync;
export const Database: typeof import("node:sqlite").DatabaseSync =
	"Bun" in globalThis ? require("bun:sqlite").Database : require("node:sqlite").DatabaseSync;

/** Open with the same wait the store uses, so a concurrent writer is a pause, not an immediate error. */
export function openDatabase(file: string): Database {
	const db = new Database(file);
	db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
	return db;
}
