/**
 * Registry-shape tests for the tool tables produced by the #3 refactor,
 * updated to assert the `godot_` prefix rename from issue #4.
 *
 * These assert structural invariants of the per-area tool arrays — names,
 * input-schema shape, handler arity — without invoking Godot. The behavioral
 * surface stays delegated to real integration tests that land alongside the
 * tool implementations in later waves.
 */

import { describe, it, expect } from "vitest";

import { editorTools } from "./editor-tools.js";
import { sceneTools } from "./scene-tools.js";
import { projectTools } from "./project-tools.js";
import { allTools } from "./index.js";

/**
 * The canonical renamed tool names after issue #4. Every name on this list
 * must appear in `allTools`; no old (non-prefixed) name may remain.
 */
const RENAMED_TOOLS = [
  "godot_launch_editor",
  "godot_run_project",
  "godot_stop_project",
  "godot_get_debug_output",
  "godot_get_version",
  "godot_list_projects",
  "godot_get_project_info",
  "godot_create_scene",
  "godot_add_node",
  "godot_load_sprite",
  "godot_export_mesh_library",
  "godot_save_scene",
  "godot_get_uid",
  "godot_update_project_uids",
] as const;

/**
 * Old tool names that must NOT appear anywhere in any registry after the rename.
 */
const OLD_TOOL_NAMES = [
  "launch_editor",
  "run_project",
  "stop_project",
  "get_debug_output",
  "get_godot_version",
  "list_projects",
  "get_project_info",
  "create_scene",
  "add_node",
  "load_sprite",
  "export_mesh_library",
  "save_scene",
  "get_uid",
  "update_project_uids",
];

describe("tool registries", () => {
  it("editor-tools.ts exposes the editor-area tools with godot_ prefix", () => {
    const names = editorTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "godot_launch_editor",
        "godot_run_project",
        "godot_stop_project",
        "godot_get_debug_output",
        "godot_get_version",
      ].sort(),
    );
  });

  it("scene-tools.ts exposes the scene-area tools with godot_ prefix", () => {
    const names = sceneTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "godot_create_scene",
        "godot_add_node",
        "godot_load_sprite",
        "godot_export_mesh_library",
        "godot_save_scene",
      ].sort(),
    );
  });

  it("project-tools.ts exposes the project-area tools with godot_ prefix", () => {
    const names = projectTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "godot_list_projects",
        "godot_get_project_info",
        "godot_get_uid",
        "godot_update_project_uids",
      ].sort(),
    );
  });

  it("allTools is the union of editor/scene/project tools, no duplicates", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...RENAMED_TOOLS].sort());
  });

  it("no old (non-prefixed) tool names survive in any registry", () => {
    const allNames = allTools.map((t) => t.name);
    for (const oldName of OLD_TOOL_NAMES) {
      expect(allNames).not.toContain(oldName);
    }
  });

  it("each tool definition has a non-empty description, schema, and async handler", () => {
    for (const tool of allTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.handler).toBeTypeOf("function");
    }
  });
});
