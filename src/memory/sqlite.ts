import { createRequire } from "node:module";

/** Pi's standalone binary uses Bun; npm Pi and tests use Node. Both bundle SQLite. */
const require = createRequire(import.meta.url);
export type Database = import("node:sqlite").DatabaseSync;
export const Database: typeof import("node:sqlite").DatabaseSync =
	"Bun" in globalThis ? require("bun:sqlite").Database : require("node:sqlite").DatabaseSync;
