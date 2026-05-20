/**
 * Registry-shape tests for the tool tables produced by the #3 refactor.
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
 * The set of tool names that existed in the pre-refactor `src/index.ts`. The
 * #3 PR is a mechanical extraction — every name on this list must survive and
 * no name outside it may appear. The Wave 2 `godot_` prefix rename is #4 and
 * is intentionally not folded in here.
 */
const PRE_REFACTOR_TOOLS = [
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
] as const;

describe("tool registries", () => {
  it("editor-tools.ts exposes the editor-area tools", () => {
    const names = editorTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "launch_editor",
        "run_project",
        "stop_project",
        "get_debug_output",
        "get_godot_version",
      ].sort(),
    );
  });

  it("scene-tools.ts exposes the scene-area tools", () => {
    const names = sceneTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
      ].sort(),
    );
  });

  it("project-tools.ts exposes the project-area tools", () => {
    const names = projectTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "list_projects",
        "get_project_info",
        "get_uid",
        "update_project_uids",
      ].sort(),
    );
  });

  it("allTools is the union of editor/scene/project tools, no duplicates", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...PRE_REFACTOR_TOOLS].sort());
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
