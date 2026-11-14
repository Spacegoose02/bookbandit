import { loadConfig } from "./config.js";
import { dbPath, openDb } from "./db/client.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const { db, close } = openDb(dbPath(config.CONFIG_DIR));
const app = await buildApp(config, db);

const shutdown = async () => {
  await app.close();
  close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
