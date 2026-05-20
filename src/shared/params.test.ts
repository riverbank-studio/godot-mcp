/**
 * Tests for the snake_case ↔ camelCase parameter normalization extracted from
 * the original `src/index.ts`. The pre-refactor server accepts callers using
 * either convention; this module owns that contract.
 */

import { describe, it, expect } from "vitest";

import { normalizeParameters, convertCamelToSnakeCase } from "./params.js";

describe("normalizeParameters", () => {
  it("converts known snake_case keys to camelCase", () => {
    expect(
      normalizeParameters({
        project_path: "/p",
        scene_path: "scenes/Main.tscn",
        node_type: "Sprite2D",
      }),
    ).toEqual({
      projectPath: "/p",
      scenePath: "scenes/Main.tscn",
      nodeType: "Sprite2D",
    });
  });

  it("leaves already-camelCase keys untouched", () => {
    expect(normalizeParameters({ projectPath: "/p", scene: "main" })).toEqual({
      projectPath: "/p",
      scene: "main",
    });
  });

  it("recurses into nested objects and applies the mapping at every level", () => {
    // Pre-refactor behavior: normalization recurses into nested objects and
    // applies the snake_case→camelCase mapping table everywhere. The
    // `properties` payload is the only place that conceptually wants to
    // pass through opaquely; callers handle that themselves by keying with
    // names that aren't in the mapping table.
    expect(
      normalizeParameters({
        project_path: "/p",
        properties: { node_type: "Sprite2D" },
      }),
    ).toEqual({
      projectPath: "/p",
      properties: { nodeType: "Sprite2D" },
    });
  });

  it("leaves unmapped nested keys alone", () => {
    expect(
      normalizeParameters({
        project_path: "/p",
        properties: { custom_godot_property: 42 },
      }),
    ).toEqual({
      projectPath: "/p",
      properties: { custom_godot_property: 42 },
    });
  });

  it("passes scalars and arrays through unchanged", () => {
    expect(
      normalizeParameters({
        mesh_item_names: ["MeshA", "MeshB"],
        recursive: true,
      }),
    ).toEqual({
      meshItemNames: ["MeshA", "MeshB"],
      recursive: true,
    });
  });

  it("returns the input unchanged when given null or non-object", () => {
    expect(normalizeParameters(null as unknown as object)).toBe(null);
    expect(normalizeParameters(undefined as unknown as object)).toBe(undefined);
  });
});

describe("convertCamelToSnakeCase", () => {
  it("converts mapped camelCase keys to their canonical snake_case", () => {
    expect(
      convertCamelToSnakeCase({
        projectPath: "/p",
        scenePath: "scenes/Main.tscn",
        meshItemNames: ["A"],
      }),
    ).toEqual({
      project_path: "/p",
      scene_path: "scenes/Main.tscn",
      mesh_item_names: ["A"],
    });
  });

  it("falls back to generic camelCase → snake_case for unmapped keys", () => {
    expect(convertCamelToSnakeCase({ someExtraKey: 1 })).toEqual({
      some_extra_key: 1,
    });
  });

  it("recurses into nested objects", () => {
    expect(
      convertCamelToSnakeCase({
        scenePath: "S",
        nestedThing: { aSubKey: 2 },
      }),
    ).toEqual({
      scene_path: "S",
      nested_thing: { a_sub_key: 2 },
    });
  });
});
