#!/usr/bin/env node
/* eslint-disable no-undef --
   `console` and `process` are Node built-in globals legitimately used here.
   The eslint config does not declare Node globals; suppressed consistent with
   scripts/build.js until the eslint config is tightened during the refactor
   described in docs/DESIGN.md. */
/**
 * scripts/validate-tool-descriptions.mjs
 *
 * Standalone validation script: parses docs/tool-descriptions.md and asserts:
 *   1. All 14 expected v1 tool names appear as level-2 headings.
 *   2. Each tool section contains the required subsections:
 *        - Summary
 *        - Description
 *        - Parameters
 *        - Example invocation
 *        - Example response
 *
 * Run via:
 *   npm run validate:tools
 *
 * Exit 0 on success, exit 1 on failure.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, "..", "docs", "tool-descriptions.md");

/** Expected tool names (14 v1 tools). */
const EXPECTED_TOOLS = [
  // Docs (6)
  "godot_search_api",
  "godot_get_class",
  "godot_find_member",
  "godot_search_tutorials",
  "godot_get_tutorial",
  "godot_docs_info",
  // LSP read (7)
  "godot_find_definition",
  "godot_find_references",
  "godot_hover",
  "godot_document_symbols",
  "godot_workspace_symbols",
  "godot_get_diagnostics",
  "godot_signature_help",
  // LSP advisory-write (1)
  "godot_preview_rename",
];

/** Required subsection keywords in each tool section (case-insensitive). */
const REQUIRED_SUBSECTIONS = [
  "summary",
  "description",
  "parameters",
  "example invocation",
  "example response",
];

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

let content;
try {
  content = readFileSync(docPath, "utf-8");
} catch (err) {
  console.error(`ERROR: Cannot read ${docPath}`);
  console.error(err.message);
  process.exit(1);
}

const lines = content.split("\n");

/**
 * Map from tool name → array of subsection heading texts found in its section.
 * @type {Map<string, string[]>}
 */
const toolSections = new Map();

/** @type {string | null} */
let currentTool = null;

for (const line of lines) {
  const h2Match = line.match(/^##\s+(`?)(\w+)\1\s*$/);
  if (h2Match) {
    const candidate = h2Match[2];
    if (EXPECTED_TOOLS.includes(candidate)) {
      currentTool = candidate;
      toolSections.set(currentTool, []);
    } else {
      currentTool = null;
    }
    continue;
  }

  if (currentTool) {
    // Collect level-3 or level-4 subsection headings within the tool's section.
    const subMatch = line.match(/^#{3,4}\s+(.+)$/);
    if (subMatch) {
      toolSections.get(currentTool).push(subMatch[1].trim().toLowerCase());
    }
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

let failed = false;

// 1. All 14 tools present.
for (const name of EXPECTED_TOOLS) {
  if (!toolSections.has(name)) {
    console.error(`FAIL: Missing section for tool "${name}" in ${docPath}`);
    failed = true;
  }
}

// 2. Each present tool has required subsections.
for (const [toolName, subsections] of toolSections) {
  for (const required of REQUIRED_SUBSECTIONS) {
    const found = subsections.some((s) => s.includes(required.toLowerCase()));
    if (!found) {
      console.error(
        `FAIL: Tool "${toolName}" is missing required subsection "${required}"`,
      );
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

const count = toolSections.size;
console.log(
  `OK: docs/tool-descriptions.md contains ${count}/${EXPECTED_TOOLS.length} tool sections, all with required subsections.`,
);
