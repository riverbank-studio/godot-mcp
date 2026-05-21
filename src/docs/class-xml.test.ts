/**
 * Tests for `class-xml` — parser for Godot's `doc/classes/*.xml` shape.
 *
 * Godot ships one XML per class. The parser normalizes each file into a
 * `ParsedClass` record + `ParsedMember[]` consumable by the schema writer.
 * Tests use minimal fixtures inline rather than depending on a real
 * Godot tarball.
 */

import { describe, it, expect } from "vitest";

import { parseClassXml, type ParsedClass } from "./class-xml.js";

const OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<class name="Object" inherits="" version="4.5">
  <brief_description>
    Base class for all objects.
  </brief_description>
  <description>
    Object is the base class for all non-built-in types.
  </description>
  <methods>
    <method name="get_class" qualifiers="const">
      <return type="StringName" />
      <description>
        Returns the class name.
      </description>
    </method>
    <method name="connect">
      <return type="int" />
      <param index="0" name="signal" type="StringName" />
      <param index="1" name="callable" type="Callable" />
      <description>
        Connects a signal.
      </description>
    </method>
  </methods>
  <signals>
    <signal name="property_list_changed">
      <description>
        Emitted when the property list changes.
      </description>
    </signal>
  </signals>
</class>
`;

const NODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<class name="Node" inherits="Object" version="4.5">
  <brief_description>Base class for scene tree nodes.</brief_description>
  <description>Scene nodes.</description>
  <members>
    <member name="name" type="StringName" default="&amp;&quot;&quot;">
      The node's name.
    </member>
  </members>
  <constants>
    <constant name="NOTIFICATION_READY" value="13">
      Sent when ready.
    </constant>
  </constants>
</class>
`;

describe("parseClassXml — basic shape", () => {
  it("extracts class name, inherits, and version", () => {
    const r = parseClassXml(OBJECT_XML);
    expect(r.cls.name).toBe("Object");
    expect(r.cls.inherits).toBeNull();
    expect(r.cls.version).toBe("4.5");
  });

  it("normalizes empty inherits to null", () => {
    const r = parseClassXml(OBJECT_XML);
    expect(r.cls.inherits).toBeNull();
  });

  it("preserves inherits when set", () => {
    const r = parseClassXml(NODE_XML);
    expect(r.cls.inherits).toBe("Object");
  });

  it("trims whitespace in brief / description", () => {
    const r = parseClassXml(OBJECT_XML);
    expect(r.cls.brief).toBe("Base class for all objects.");
    expect(r.cls.description).toContain("Object is the base class");
  });
});

describe("parseClassXml — methods", () => {
  it("captures methods with name, signature, and description", () => {
    const r = parseClassXml(OBJECT_XML);
    const methods = r.members.filter((m) => m.kind === "method");
    expect(methods.length).toBe(2);

    const getClass = methods.find((m) => m.name === "get_class");
    expect(getClass).toBeDefined();
    expect(getClass!.signature).toContain("get_class");
    expect(getClass!.signature).toContain("StringName");
    expect(getClass!.signature).toContain("const");

    const connect = methods.find((m) => m.name === "connect");
    expect(connect).toBeDefined();
    expect(connect!.signature).toContain("signal: StringName");
    expect(connect!.signature).toContain("callable: Callable");
    expect(connect!.signature).toContain("-> int");
  });
});

describe("parseClassXml — signals", () => {
  it("captures signals", () => {
    const r = parseClassXml(OBJECT_XML);
    const signals = r.members.filter((m) => m.kind === "signal");
    expect(signals.length).toBe(1);
    expect(signals[0]!.name).toBe("property_list_changed");
  });
});

describe("parseClassXml — properties", () => {
  it("captures members (properties) with type + default", () => {
    const r = parseClassXml(NODE_XML);
    const props = r.members.filter((m) => m.kind === "property");
    expect(props.length).toBe(1);
    expect(props[0]!.name).toBe("name");
    expect(props[0]!.signature).toContain("StringName");
    // XML-decoded default: `&` → `&`, `&quot;` → `"` → resulting "".
    expect(props[0]!.signature).toContain('""');
  });
});

describe("parseClassXml — constants", () => {
  it("captures constants with value", () => {
    const r = parseClassXml(NODE_XML);
    const consts = r.members.filter((m) => m.kind === "constant");
    expect(consts.length).toBe(1);
    expect(consts[0]!.name).toBe("NOTIFICATION_READY");
    expect(consts[0]!.signature).toContain("13");
  });
});

describe("parseClassXml — malformed input", () => {
  it("throws on missing class element", () => {
    expect(() => parseClassXml("<not-a-class />")).toThrow();
  });

  it("throws on missing class name attribute", () => {
    expect(() =>
      parseClassXml('<?xml version="1.0"?><class inherits="Object"></class>'),
    ).toThrow(/name/i);
  });
});

describe("parseClassXml — Object class invariant", () => {
  it("returns a recognizable class structure (validation hook)", () => {
    // The ingest pipeline's structural validation (DESIGN.md L260)
    // calls `parseClassXml` on `Object.xml` as a smoke check. Confirm
    // the parser returns the canonical shape.
    const r = parseClassXml(OBJECT_XML);
    const want: Partial<ParsedClass> = {
      name: "Object",
      inherits: null,
    };
    expect(r.cls).toMatchObject(want);
    expect(r.members.length).toBeGreaterThan(0);
  });
});
