import { loadEnv } from "../src/config/env.js";
import { openDatabase } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrations.js";

const env = loadEnv();
const db = openDatabase(env.databasePath);
runMigrations(db);

