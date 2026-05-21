/**
 * Parameter-name normalization between snake_case (the MCP wire convention
 * preferred by Python-trained agents) and camelCase (the internal TS
 * convention). Callers may submit either; handlers always see camelCase, and
 * the bundled-GDScript invocation gets snake_case on the way out.
 *
 * When a new MCP parameter is added, register it here in both directions so
 * external callers can use either style.
 */

import type { OperationParams } from "./types.js";

/**
 * Forward mapping: snake_case (wire) → camelCase (internal).
 *
 * Keys without a mapping pass through unchanged. The `properties` key is in
 * the map only to document that we deliberately do not transform its nested
 * payload (the value is opaque Godot property data, not MCP parameters).
 */
export const parameterMappings: Record<string, string> = {
  project_path: "projectPath",
  scene_path: "scenePath",
  root_node_type: "rootNodeType",
  parent_node_path: "parentNodePath",
  node_type: "nodeType",
  node_name: "nodeName",
  texture_path: "texturePath",
  node_path: "nodePath",
  output_path: "outputPath",
  mesh_item_names: "meshItemNames",
  new_path: "newPath",
  file_path: "filePath",
  directory: "directory",
  recursive: "recursive",
  scene: "scene",
};

/**
 * Reverse mapping camelCase → snake_case. Lazily built from `parameterMappings`.
 */
export const reverseParameterMappings: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [snake, camel] of Object.entries(parameterMappings)) {
    out[camel] = snake;
  }
  return out;
})();

/**
 * Normalize input parameters to internal (camelCase) form. Recurses into
 * nested objects. Returns the input unchanged when given a non-object value.
 */
export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== "object") {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      // Convert snake_case → camelCase using our mapping when available.
      if (key.includes("_") && parameterMappings[key]) {
        normalizedKey = parameterMappings[key];
      }

      const value = params[key];
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        result[normalizedKey] = normalizeParameters(value as OperationParams);
      } else {
        result[normalizedKey] = value;
      }
    }
  }

  return result;
}

/**
 * Convert an internal (camelCase) parameter object back to snake_case for
 * dispatch to the bundled GDScript. Mapped keys use the canonical snake form
 * from `reverseParameterMappings`; unmapped keys fall back to a generic
 * camelCase → snake_case transform so the GDScript sees consistent shape.
 */
export function convertCamelToSnakeCase(
  params: OperationParams,
): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey =
        reverseParameterMappings[key] ||
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

      const value = params[key];
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        result[snakeKey] = convertCamelToSnakeCase(value as OperationParams);
      } else {
        result[snakeKey] = value;
      }
    }
  }

  return result;
}
