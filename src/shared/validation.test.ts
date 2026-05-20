/**
 * Tests for the path-traversal and class-name validators. These guard every
 * tool that touches the filesystem or instantiates a Godot class from a
 * caller-supplied name — keep coverage tight when extending them.
 */

import { describe, it, expect } from "vitest";

import { validatePath, validateClassName } from "./validation.js";

describe("validatePath", () => {
  it("rejects empty input", () => {
    expect(validatePath("")).toBe(false);
  });

  it("rejects paths containing '..'", () => {
    expect(validatePath("foo/../etc/passwd")).toBe(false);
    expect(validatePath("..")).toBe(false);
  });

  it("accepts normal relative and absolute paths", () => {
    expect(validatePath("scenes/Main.tscn")).toBe(true);
    expect(validatePath("/abs/path/project")).toBe(true);
    expect(validatePath("C:/projects/foo")).toBe(true);
  });
});

describe("validateClassName", () => {
  it("accepts simple Godot identifiers", () => {
    expect(validateClassName("Node2D")).toBe(true);
    expect(validateClassName("CharacterBody3D")).toBe(true);
    expect(validateClassName("_Underscore")).toBe(true);
  });

  it("rejects anything that looks like a path or non-identifier", () => {
    expect(validateClassName("res://Foo.gd")).toBe(false);
    expect(validateClassName("/abs/path")).toBe(false);
    expect(validateClassName("Foo.Bar")).toBe(false);
    expect(validateClassName("Foo Bar")).toBe(false);
    expect(validateClassName("1NotAnIdentifier")).toBe(false);
    expect(validateClassName("")).toBe(false);
  });
});
