import katex from "katex";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { SANITIZE_SCHEMA } from "@/components/MemoContent/constants";

// Keep the order and KaTeX options aligned with MemoMarkdownRenderer: sanitize
// user HTML first, then render math with KaTeX's default untrusted-command policy.
const renderMath = (content: string): HTMLDivElement => {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], [rehypeKatex, { throwOnError: false, strict: false }]]}
    >
      {content}
    </ReactMarkdown>,
  );
  return element;
};

describe("math rendering compatibility", () => {
  it("renders inline fractions while preserving surrounding Chinese text", () => {
    const output = renderMath(String.raw`计算结果为 $\frac{1}{2} + x^2$，继续记录。`);

    expect(output.querySelectorAll(".katex")).toHaveLength(1);
    expect(output.querySelector("mfrac")).not.toBeNull();
    expect(output.querySelector(".katex-display")).toBeNull();
    expect(output.textContent).toContain("计算结果为");
    expect(output.textContent).toContain("，继续记录。");
    expect(output.querySelector(".katex-error")).toBeNull();
  });

  it("renders block matrices and text through the complete Markdown math pipeline", () => {
    const output = renderMath(String.raw`矩阵如下：

$$
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\quad\text{单位：米}
$$

公式之后的笔记。`);

    expect(output.querySelector(".katex-display .katex")).not.toBeNull();
    expect(output.querySelectorAll("mtable mtr")).toHaveLength(2);
    expect(output.textContent).toContain("单位：米");
    expect(output.textContent).toContain("公式之后的笔记。");
    expect(output.querySelector(".katex-error")).toBeNull();
  });

  it("keeps an invalid formula readable without preventing later content from rendering", () => {
    const output = renderMath(String.raw`前文 $\frac{1}{$ 后文。

接下来仍可显示 $a+b$。`);

    const error = output.querySelector(".katex-error");
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain(String.raw`\frac{1}{`);
    expect(output.textContent).toContain("后文。");
    expect(output.textContent).toContain("接下来仍可显示");
    expect(output.querySelectorAll(".katex")).toHaveLength(1);
  });
});

describe("math command trust restrictions", () => {
  it("does not inherit a trust override from the options prototype", () => {
    const options = Object.assign(Object.create({ trust: true }), { strict: false, throwOnError: false });
    const output = document.createElement("div");
    output.innerHTML = katex.renderToString(String.raw`\href{https://math-audit.invalid}{x}`, options);

    expect(output.querySelector(".katex")).not.toBeNull();
    expect(output.querySelector("a[href]")).toBeNull();
  });

  it.each([
    [String.raw`\href{javascript:alert(1)}{link}`, "a[href]"],
    [String.raw`\htmlStyle{position:fixed;inset:0}{x}`, '[style*="fixed"]'],
    [String.raw`\htmlId{audit-math-overlay}{x}`, "#audit-math-overlay"],
    [String.raw`\htmlClass{audit-math-overlay}{x}`, ".audit-math-overlay"],
    [String.raw`\htmlData{audit=enabled}{x}`, "[data-audit]"],
    [String.raw`\includegraphics{https://math-audit.invalid/image.png}`, "img"],
  ])("does not execute the untrusted command %s", (formula, forbiddenSelector) => {
    const output = renderMath(`$${formula}$`);

    expect(output.querySelector(".katex")).not.toBeNull();
    expect(output.querySelector(forbiddenSelector)).toBeNull();
    expect(output.querySelector("script")).toBeNull();
  });
});
