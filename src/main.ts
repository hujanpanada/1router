import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./db.js";
import { createServer } from "./server.js";
import { ensureLoginPassword, passwordIsDefault, DEFAULT_PASSWORD } from "./auth.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.DB_PATH ?? "data/1router.db";

mkdirSync(dirname(dbPath), { recursive: true });
const db = createDb(dbPath);
const seeded = ensureLoginPassword(db);

const server = createServer({ db });
server.listen(port, host, () => {
  console.log(`1Router listening on http://${host}:${port}`);
  console.log(`Open the dashboard:  http://${host}:${port}/`);
  if (seeded || passwordIsDefault(db)) {
    console.log(`Login password is the default: "${DEFAULT_PASSWORD}" — change it in Settings after logging in.`);
  }
  if (host !== "127.0.0.1") console.warn("WARNING: bound beyond localhost. The dashboard is password-protected, but use HTTPS in front of it for real exposure.");
});
