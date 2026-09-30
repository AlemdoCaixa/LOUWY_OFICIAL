import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDefaultChurch,
  ensureState,
  initializeDatabase,
  listChurches,
  pool,
  writeChurchState,
} from "./state-db.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes("--force");
const workspace = JSON.parse(await readFile(join(base, "data", "workspace.json"), "utf8"));
const catalog = JSON.parse(await readFile(join(base, "data", "catalog.json"), "utf8"));

await initializeDatabase();
await ensureState("workspace", workspace);
await ensureState("catalog", catalog);
const church = await ensureDefaultChurch({
  slug: process.env.DEFAULT_CHURCH_SLUG || "primicias",
  name: workspace?.branding?.organizationName || "Ministério Primícias",
  workspace,
  catalog,
});
if (force) {
  await writeChurchState(church.id, "workspace", workspace);
  await writeChurchState(church.id, "catalog", catalog);
}

const states = await pool.query(
  "SELECT church_id, key, version, updated_at FROM church_state ORDER BY church_id, key",
);
console.log(JSON.stringify({
  defaultChurch: church,
  churches: await listChurches(),
  states: states.rows,
}, null, 2));
await pool.end();
