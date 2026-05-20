/**
 * Input validators used by every filesystem-touching and class-instantiating
 * tool. Keep these regex-simple and over-strict by default.
 */

/**
 * Reject obviously dangerous filesystem paths (path-traversal, empty input).
 * Tools should validate every path-shaped argument through this gate before
 * passing it to a Godot or Node API.
 */
export function validatePath(path: string): boolean {
  if (!path || path.includes("..")) {
    return false;
  }
  return true;
}

/**
 * Validate that a string is a simple Godot class identifier — letters, digits,
 * and underscores, not starting with a digit. Rejects anything that looks like
 * a path or a script reference (`res://...`, `/abs/...`, `Foo.gd`, etc.) so
 * tool callers cannot inject arbitrary classes into the bundled GDScript.
 */
export function validateClassName(name: string): boolean {
  if (!name) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
