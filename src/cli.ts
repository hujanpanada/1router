import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./db.js";

const dbPath = process.env.DB_PATH ?? "data/1router.db";
mkdirSync(dirname(dbPath), { recursive: true });
const db = createDb(dbPath);
const [cmd, arg] = process.argv.slice(2);

if (cmd === "key:create") {
  const { key, name } = db.createKey(arg ?? "default");
  console.log(`Created key "${name}" (shown only once):\n${key}`);
} else if (cmd === "key:list") {
  for (const k of db.listKeys()) console.log(`${k.id}\t${k.name}\tcreated ${new Date(k.createdAt).toISOString()}${k.revokedAt ? "\tREVOKED" : ""}`);
} else if (cmd === "key:revoke" && arg && /^\d+$/.test(arg) && db.listKeys().some((k) => k.id === Number(arg) && !k.revokedAt)) {
  db.revokeKey(Number(arg));
  console.log(`Revoked key ${arg}`);
} else if (cmd === "key:revoke") {
  console.error(`Key ${arg ?? ""} was not found or is already revoked.`);
  db.close();
  process.exit(1);
} else {
  console.error("Usage: cli.js key:create [name] | key:list | key:revoke <id>");
  process.exit(1);
}
db.close();
