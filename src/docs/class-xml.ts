/**
 * Parser for Godot's class-reference XML format (`doc/classes/*.xml`).
 *
 * Each XML file documents one class with the shape:
 *
 *   ```xml
 *   <class name="Object" inherits="" version="4.5">
 *     <brief_description>...</brief_description>
 *     <description>...</description>
 *     <methods>
 *       <method name="..." qualifiers="...">
 *         <return type="..." />
 *         <param index="..." name="..." type="..." default="..." />
 *         <description>...</description>
 *       </method>
 *     </methods>
 *     <signals>...</signals>
 *     <members>...</members>
 *     <constants>...</constants>
 *     <annotations>...</annotations>
 *   </class>
 *   ```
 *
 * The parser normalizes each entry into a flat `ParsedMember` record with
 * a `kind` discriminant (method / property / signal / constant /
 * annotation) matching the unified members table in DESIGN.md
 * § Schema overview.
 *
 * Why `fast-xml-parser` instead of `xmldom` / a hand-roll
 * -------------------------------------------------------
 * `fast-xml-parser` is pure JS (no native deps, important for the
 * unsupported-platforms list at DESIGN.md L580), handles entity decoding,
 * and produces a stable object shape we can navigate without DOM
 * boilerplate. The parser is configured with `preserveOrder: false`
 * because we extract by element name; order within a parent doesn't
 * affect the normalized output.
 */

import { XMLParser } from "fast-xml-parser";

/**
 * Top-level normalized record for one class XML file.
 */
export interface ParsedClass {
  /** Class name (XML `name` attribute). Always present. */
  name: string;
  /** Immediate parent class name, or `null` when the field is empty. */
  inherits: string | null;
  /** Godot version this XML was extracted from (XML `version` attribute). */
  version: string | null;
  /** One-line summary from `<brief_description>`. Whitespace-collapsed. */
  brief: string;
  /** Long-form description. Whitespace-trimmed but newlines preserved. */
  description: string;
}

/**
 * Member kinds. Matches the `kind` column of the unified `members` table
 * (DESIGN.md § Schema overview).
 */
export type MemberKind =
  | "method"
  | "property"
  | "signal"
  | "constant"
  | "annotation";

/**
 * One row of the `members` table. The `signature` field is a rendered
 * string suitable for both FTS5 indexing and direct display in tool
 * responses.
 */
export interface ParsedMember {
  kind: MemberKind;
  name: string;
  /** Rendered display form. Shape varies by `kind`. */
  signature: string;
  /** Free-text description. May be empty. */
  description: string;
}

/**
 * Parser result. The caller writes `cls` into the `classes` table and
 * each `members[i]` into the `members` table.
 */
export interface ParseClassXmlResult {
  cls: ParsedClass;
  members: ParsedMember[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  // Trim text nodes' surrounding whitespace; preserve interior content.
  trimValues: true,
  // Always coerce to array for the per-kind element so iteration is uniform
  // (a single `<method>` would otherwise produce an object, not a list).
  isArray: (name) =>
    ["method", "param", "signal", "member", "constant", "annotation"].includes(
      name,
    ),
});

/**
 * Parse one XML file's contents. Throws when the root element isn't
 * `<class>` or when the `name` attribute is missing — both are
 * structural errors the ingest pipeline counts toward the failure
 * threshold (DESIGN.md L273).
 */
export function parseClassXml(xml: string): ParseClassXmlResult {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const classNode = parsed.class;
  if (!isObject(classNode)) {
    throw new Error("class-xml: root element must be <class>");
  }
  const name = readAttr(classNode, "@name");
  if (!name) {
    throw new Error("class-xml: <class> is missing a name attribute");
  }
  const inheritsRaw = readAttr(classNode, "@inherits");
  const cls: ParsedClass = {
    name,
    inherits: inheritsRaw && inheritsRaw.trim() !== "" ? inheritsRaw : null,
    version: readAttr(classNode, "@version"),
    brief: collapseWhitespace(readChildText(classNode, "brief_description")),
    description: trimMultiline(readChildText(classNode, "description")),
  };

  const members: ParsedMember[] = [
    ...extractMethods(classNode),
    ...extractProperties(classNode),
    ...extractSignals(classNode),
    ...extractConstants(classNode),
    ...extractAnnotations(classNode),
  ];

  return { cls, members };
}

/**
 * Extract <methods><method>...</method></methods>.
 *
 * Rendered signature shape: `name(param1: T1, param2: T2) -> R [const]`.
 */
function extractMethods(node: Record<string, unknown>): ParsedMember[] {
  const methodsNode = node.methods;
  if (!isObject(methodsNode)) return [];
  const list = methodsNode.method;
  if (!Array.isArray(list)) return [];
  const out: ParsedMember[] = [];
  for (const m of list) {
    if (!isObject(m)) continue;
    const mname = readAttr(m, "@name");
    if (!mname) continue;
    const qualifiers = readAttr(m, "@qualifiers");
    const ret = isObject(m.return) ? readAttr(m.return, "@type") : null;
    const params: string[] = [];
    if (Array.isArray(m.param)) {
      for (const p of m.param) {
        if (!isObject(p)) continue;
        const pname = readAttr(p, "@name");
        const ptype = readAttr(p, "@type");
        const pdefault = readAttr(p, "@default");
        if (pname && ptype) {
          let s = `${pname}: ${ptype}`;
          if (pdefault) s += ` = ${pdefault}`;
          params.push(s);
        }
      }
    }
    let signature = `${mname}(${params.join(", ")})`;
    if (ret) signature += ` -> ${ret}`;
    if (qualifiers) signature += ` ${qualifiers}`;
    out.push({
      kind: "method",
      name: mname,
      signature,
      description: trimMultiline(readChildText(m, "description")),
    });
  }
  return out;
}

/**
 * Extract <members><member>...</member></members>. In Godot's XML,
 * `<member>` is a class property — re-mapped to `kind: "property"`
 * in the unified `members` table to disambiguate from the XML element
 * name.
 */
function extractProperties(node: Record<string, unknown>): ParsedMember[] {
  const membersNode = node.members;
  if (!isObject(membersNode)) return [];
  const list = membersNode.member;
  if (!Array.isArray(list)) return [];
  const out: ParsedMember[] = [];
  for (const p of list) {
    if (!isObject(p)) continue;
    const pname = readAttr(p, "@name");
    const ptype = readAttr(p, "@type");
    if (!pname) continue;
    const pdefault = readAttr(p, "@default");
    let signature = pname;
    if (ptype) signature += `: ${ptype}`;
    if (pdefault) signature += ` = ${pdefault}`;
    out.push({
      kind: "property",
      name: pname,
      signature,
      description: collapseWhitespace(textContent(p)),
    });
  }
  return out;
}

/**
 * Extract <signals><signal>...</signal></signals>. Rendered signature
 * is the bare name (Godot signals carry params but the schema's
 * `signature` column is rendered as `name(param: T, ...)`).
 */
function extractSignals(node: Record<string, unknown>): ParsedMember[] {
  const signalsNode = node.signals;
  if (!isObject(signalsNode)) return [];
  const list = signalsNode.signal;
  if (!Array.isArray(list)) return [];
  const out: ParsedMember[] = [];
  for (const s of list) {
    if (!isObject(s)) continue;
    const sname = readAttr(s, "@name");
    if (!sname) continue;
    const params: string[] = [];
    if (Array.isArray(s.param)) {
      for (const p of s.param) {
        if (!isObject(p)) continue;
        const pname = readAttr(p, "@name");
        const ptype = readAttr(p, "@type");
        if (pname && ptype) params.push(`${pname}: ${ptype}`);
      }
    }
    out.push({
      kind: "signal",
      name: sname,
      signature: `${sname}(${params.join(", ")})`,
      description: trimMultiline(readChildText(s, "description")),
    });
  }
  return out;
}

/**
 * Extract <constants><constant>...</constant></constants>. Signature
 * renders as `NAME = value`.
 */
function extractConstants(node: Record<string, unknown>): ParsedMember[] {
  const constsNode = node.constants;
  if (!isObject(constsNode)) return [];
  const list = constsNode.constant;
  if (!Array.isArray(list)) return [];
  const out: ParsedMember[] = [];
  for (const c of list) {
    if (!isObject(c)) continue;
    const cname = readAttr(c, "@name");
    const cvalue = readAttr(c, "@value");
    if (!cname) continue;
    out.push({
      kind: "constant",
      name: cname,
      signature: cvalue !== null ? `${cname} = ${cvalue}` : cname,
      description: collapseWhitespace(textContent(c)),
    });
  }
  return out;
}

/**
 * Extract <annotations><annotation>...</annotation></annotations>.
 * Annotations are decorator-like markers (e.g. `@export`).
 */
function extractAnnotations(node: Record<string, unknown>): ParsedMember[] {
  const annNode = node.annotations;
  if (!isObject(annNode)) return [];
  const list = annNode.annotation;
  if (!Array.isArray(list)) return [];
  const out: ParsedMember[] = [];
  for (const a of list) {
    if (!isObject(a)) continue;
    const aname = readAttr(a, "@name");
    if (!aname) continue;
    out.push({
      kind: "annotation",
      name: aname,
      signature: aname,
      description: trimMultiline(readChildText(a, "description")),
    });
  }
  return out;
}

/**
 * Read an attribute from a parsed XML node. Returns `null` for missing
 * attributes (rather than the empty string) so callers can distinguish
 * "set to empty" from "absent."
 */
function readAttr(node: Record<string, unknown>, attr: string): string | null {
  const v = node[attr];
  return typeof v === "string" ? v : null;
}

/**
 * Read the text content of a named child element, e.g.
 * `<description>foo</description>`. Returns `""` when absent.
 */
function readChildText(
  node: Record<string, unknown>,
  childName: string,
): string {
  const child = node[childName];
  if (typeof child === "string") return child;
  if (isObject(child)) {
    const t = child["#text"];
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * Get the text content of a node — used for properties / constants
 * where the description lives directly in the element's body rather
 * than in a `<description>` child.
 */
function textContent(node: Record<string, unknown>): string {
  const t = node["#text"];
  return typeof t === "string" ? t : "";
}

/**
 * Collapse all internal whitespace to a single space and trim. Used for
 * brief descriptions and short signatures.
 */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Trim leading/trailing whitespace on each line and strip empty leading
 * and trailing lines. Used for multi-line descriptions — preserves
 * paragraph breaks but cleans up the indentation that XML
 * pretty-printing introduces.
 */
function trimMultiline(s: string): string {
  return s
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Narrow `unknown` to `Record<string, unknown>`. Local to this module
 * to keep the parser self-contained.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
