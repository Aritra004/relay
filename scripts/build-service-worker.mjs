import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const buildId = (await readFile(".next/BUILD_ID", "utf8")).trim();
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(filename) : filename;
    }),
  );
  return files.flat();
}
const assets = (await filesUnder(".next/static"))
  .filter((file) => !file.endsWith(".map"))
  .map(
    (file) =>
      "/_next/" + path.relative(".next", file).split(path.sep).join("/"),
  );
const template = await readFile("scripts/service-worker.js", "utf8");
await writeFile(
  "public/sw.js",
  template
    .replace("__CACHE_NAME__", JSON.stringify(`relay-shell-${buildId}`))
    .replace(
      "__PRECACHE__",
      JSON.stringify(["/", "/offline", "/icon.svg", "/favicon.ico", ...assets]),
    ),
);
console.log(`Prepared offline shell: ${assets.length} build assets.`);
