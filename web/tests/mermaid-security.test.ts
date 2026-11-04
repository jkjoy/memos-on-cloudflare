import mermaid from "mermaid";
import { describe, expect, it } from "vitest";

describe("Mermaid chart safety", () => {
  it("parses an equal-bound XY chart without unbounded category generation", async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const push = Array.prototype.push;
    let repeatedCategories = 0;
    // Stop the old vulnerable implementation before it can hang the test
    // process. The fixed parser derives categories from the finite data array.
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items.length === 1 && items[0] === "1" && ++repeatedCategories > 1000) {
        throw new Error("Unbounded Mermaid category generation");
      }
      return push.apply(this, items);
    };
    try {
      await expect(mermaid.parse("xychart\n x-axis 1 --> 1\n line [1,2]")).resolves.toMatchObject({ diagramType: "xychart" });
    } finally {
      Array.prototype.push = push;
    }
  });

  it("renders math labels with the shared KaTeX version", async () => {
    // jsdom has no SVG layout engine. Supply geometry for the diagram layout;
    // the formula parsing, HTML generation and sanitization remain real.
    const getBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 30 }),
    });
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", forceLegacyMathML: true });
      const { svg } = await mermaid.render(
        "math-compatibility-chart",
        String.raw`flowchart LR
        A["$$\frac{1}{2}$$"] --> B["Done"]`,
      );
      const output = document.createElement("div");
      output.innerHTML = svg;
      expect(output.querySelector("svg")).not.toBeNull();
      expect(output.querySelector(".katex math mfrac")).not.toBeNull();
      expect(output.querySelector(".katex-error")).toBeNull();
      expect(output.textContent).toContain("Done");
    } finally {
      if (getBBox) {
        Object.defineProperty(SVGElement.prototype, "getBBox", getBBox);
      } else {
        Reflect.deleteProperty(SVGElement.prototype, "getBBox");
      }
    }
  });
});
