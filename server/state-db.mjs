import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql:///louvelab?host=/tmp",
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => {
  console.error("PostgreSQL pool error", error);
});

export function normalizeChurchSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "")
    .slice(0, 48);
}
export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS churches (
      id text PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS church_state (
      church_id text NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      key text NOT NULL,
      value jsonb NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (church_id, key)
    );
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS church_state_church_idx ON church_state (church_id)");
}
export async function ensureState(key, fallback) {
  await pool.query(
    `INSERT INTO app_state (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(fallback)],
  );
}

export async function readState(key) {
  const result = await pool.query(
    "SELECT value, version FROM app_state WHERE key = $1",
    [key],
  );
  if (!result.rowCount) throw new Error(`State not initialized: ${key}`);
  return structuredClone(result.rows[0].value);
}

export async function writeState(key, value) {
  const result = await pool.query(
    `UPDATE app_state
       SET value = $2::jsonb, version = version + 1, updated_at = now()
     WHERE key = $1 RETURNING version, updated_at`,
    [key, JSON.stringify(value)],
  );
  if (!result.rowCount) throw new Error(`State not initialized: ${key}`);
  return result.rows[0];
}
function publicChurch(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    active: row.active !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : "",
  };
}

export async function listChurches() {
  const result = await pool.query(
    "SELECT id, slug, name, active, created_at, updated_at FROM churches WHERE active = true ORDER BY created_at, slug",
  );
  return result.rows.map(publicChurch);
}

export async function findChurchBySlug(value) {
  const slug = normalizeChurchSlug(value);
  if (!slug) return null;
  const result = await pool.query(
    "SELECT id, slug, name, active, created_at, updated_at FROM churches WHERE slug = $1 AND active = true",
    [slug],
  );
  return publicChurch(result.rows[0]);
}
export async function getChurchById(id) {
  if (!id) return null;
  const result = await pool.query(
    "SELECT id, slug, name, active, created_at, updated_at FROM churches WHERE id = $1 AND active = true",
    [String(id)],
  );
  return publicChurch(result.rows[0]);
}

export async function getDefaultChurch() {
  const preferred = normalizeChurchSlug(process.env.DEFAULT_CHURCH_SLUG || "primicias");
  const preferredChurch = await findChurchBySlug(preferred);
  if (preferredChurch) return preferredChurch;
  const result = await pool.query(
    "SELECT id, slug, name, active, created_at, updated_at FROM churches WHERE active = true ORDER BY created_at, slug LIMIT 1",
  );
  return publicChurch(result.rows[0]);
}

export async function ensureChurchState(churchId, key, fallback, client = pool) {
  await client.query(
    `INSERT INTO church_state (church_id, key, value)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (church_id, key) DO NOTHING`,
    [churchId, key, JSON.stringify(fallback)],
  );
}
export async function readChurchState(churchId, key) {
  const result = await pool.query(
    "SELECT value, version FROM church_state WHERE church_id = $1 AND key = $2",
    [churchId, key],
  );
  if (!result.rowCount) throw new Error(`Church state not initialized: ${churchId}/${key}`);
  return structuredClone(result.rows[0].value);
}

export async function writeChurchState(churchId, key, value) {
  const result = await pool.query(
    `UPDATE church_state
       SET value = $3::jsonb, version = version + 1, updated_at = now()
     WHERE church_id = $1 AND key = $2
     RETURNING version, updated_at`,
    [churchId, key, JSON.stringify(value)],
  );
  if (!result.rowCount) throw new Error(`Church state not initialized: ${churchId}/${key}`);
  return result.rows[0];
}

export async function createChurch({ slug: inputSlug, name, workspace, catalog = [] }) {
  const slug = normalizeChurchSlug(inputSlug);
  if (!slug || slug.length < 3) throw Object.assign(new Error("Escolha um endereço com pelo menos 3 caracteres."), { code: "INVALID_CHURCH_SLUG" });
  const client = await pool.connect();
  const churchId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO churches (id, slug, name) VALUES ($1, $2, $3)`,
      [churchId, slug, String(name || "Igreja").trim().slice(0, 120)],
    );
    await ensureChurchState(churchId, "workspace", workspace, client);
    await ensureChurchState(churchId, "catalog", catalog, client);
    await client.query("COMMIT");
    return await getChurchById(churchId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505") {
      throw Object.assign(new Error("Este endereço já está sendo usado por outra igreja."), { code: "CHURCH_SLUG_TAKEN" });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDefaultChurch({ slug: inputSlug = "primicias", name = "Ministério Primícias", workspace, catalog }) {
  const slug = normalizeChurchSlug(inputSlug) || "primicias";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('louwy-default-church'))");
    const existing = await client.query("SELECT id FROM churches WHERE slug = $1 LIMIT 1", [slug]);
    let churchId = existing.rows[0]?.id;
    if (!churchId) {
      const count = await client.query("SELECT count(*)::int AS count FROM churches");
      if (Number(count.rows[0]?.count || 0) > 0) {
        const first = await client.query("SELECT id FROM churches WHERE active = true ORDER BY created_at LIMIT 1");
        churchId = first.rows[0]?.id;
      } else {
        churchId = randomUUID();
        const legacyWorkspace = await client.query("SELECT value FROM app_state WHERE key = 'workspace'");
        const legacyCatalog = await client.query("SELECT value FROM app_state WHERE key = 'catalog'");
        const initialWorkspace = legacyWorkspace.rows[0]?.value || workspace;
        const initialCatalog = legacyCatalog.rows[0]?.value || catalog || [];
        const churchName = String(initialWorkspace?.branding?.organizationName || name).trim().slice(0, 120) || name;
        await client.query(
          "INSERT INTO churches (id, slug, name) VALUES ($1, $2, $3)",
          [churchId, slug, churchName],
        );
        await ensureChurchState(churchId, "workspace", initialWorkspace, client);
        await ensureChurchState(churchId, "catalog", initialCatalog, client);
      }
    }
    await ensureChurchState(churchId, "workspace", workspace, client);
    await ensureChurchState(churchId, "catalog", catalog || [], client);
    await client.query("COMMIT");
    return await getChurchById(churchId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function stateHealth() {
  const result = await pool.query(`
    SELECT now() AS now,
           current_database() AS database,
           (SELECT count(*)::int FROM churches WHERE active = true) AS churches
  `);
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
