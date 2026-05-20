/* eslint-disable no-undef --
   TODO(refactor): `console` and `process` are Node built-in globals that this
   script legitimately uses. They flag here because eslint.config.js does not
   yet declare a Node `languageOptions.globals` env. Suppressed alongside the
   other initial-install lint errors; revisit when the eslint config is
   tightened during the refactor described in docs/DESIGN.md. */
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make the build/index.js file executable
fs.chmodSync(path.join(__dirname, "..", "build", "index.js"), "755");

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.ensureDirSync(path.join(__dirname, "..", "build", "scripts"));

  // Copy the godot_operations.gd file
  fs.copyFileSync(
    path.join(__dirname, "..", "src", "scripts", "godot_operations.gd"),
    path.join(__dirname, "..", "build", "scripts", "godot_operations.gd"),
  );

  console.log("Successfully copied godot_operations.gd to build/scripts");
} catch (error) {
  console.error("Error copying scripts:", error);
  process.exit(1);
}

// Copy the data/ directory (Godot release hash manifest + schema) into
// build/data/. The manifest is read at runtime by the docs ingestion
// pipeline (src/docs/integrity.ts) to verify tarball SHAs, so it must
// ship inside the published tarball — see docs/supply-chain.md.
try {
  const dataSrc = path.join(__dirname, "..", "data");
  const dataDst = path.join(__dirname, "..", "build", "data");
  if (fs.existsSync(dataSrc)) {
    fs.ensureDirSync(dataDst);
    for (const entry of fs.readdirSync(dataSrc)) {
      // Only ship JSON files — leaves room for future non-shippable data
      // (e.g. test fixtures, reports) to live in data/ without bloating npm.
      if (entry.endsWith(".json")) {
        fs.copyFileSync(path.join(dataSrc, entry), path.join(dataDst, entry));
      }
    }
    console.log("Successfully copied data/*.json to build/data");
  }
} catch (error) {
  console.error("Error copying data files:", error);
  process.exit(1);
}

console.log("Build scripts completed successfully!");
