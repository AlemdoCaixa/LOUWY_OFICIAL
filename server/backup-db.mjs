import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const databaseUrl = process.env.DATABASE_URL || "postgresql:///louvelab?host=/tmp";
const directory = join(process.cwd(), "backups", "postgres");
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(directory, `louvelab-${stamp}.dump`);

await new Promise((resolve, reject) => {
  const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--dbname", databaseUrl, "--file", destination], {
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}`)));
});

console.log(destination);
