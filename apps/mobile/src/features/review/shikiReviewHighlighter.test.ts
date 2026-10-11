import { describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  highlightCodeSnippet,
  highlightReviewSelectedLines,
  highlightSourceFile,
} from "./shikiReviewHighlighter";

describe("highlightSourceFile", () => {
  it("preserves one highlighted token row per source line without trailing newlines", async () => {
    const lines = [
      'const items = ["a"];',
      'expect(items).toEqual(["a"]);',
      "const next = items.map((item) => item.toUpperCase());",
      'expect(next).toContain("A");',
    ];

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example.ts",
      contents: lines.join("\n"),
      theme: "light",
    });

    expect(highlighted.map((tokens) => tokens.map((token) => token.content).join(""))).toEqual(
      lines,
    );
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example-long-line.ts",
      contents: longLine,
      theme: "light",
    });

    expect(highlighted).toEqual([
      [
        {
          content: longLine,
          color: null,
          fontStyle: null,
        },
      ],
    ]);
  });

  it("initializes source and snippet highlighting without a warmup", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";

    const highlighted = await highlighter.highlightSourceFile({
      path: "example.ts",
      contents: source,
      theme: "dark",
    });

    const sourceTokens = highlighted.flat();
    expect(sourceTokens.map((token) => token.content).join("")).toBe(source);
    expect(sourceTokens.some((token) => token.color !== null)).toBe(true);
    // CI runs 38110398025 and 38119865290 stopped mid-line. One glued the tail
    // into "= 42;"; the other left no token whose content was exactly "42".
    // Equality stays, and the number has to be its own colored token.
    expect(sourceTokens.some((token) => token.content === "= 42;")).toBe(false);
    expect(sourceTokens.find((token) => token.content === "42")?.color).toBeTruthy();
    expect(
      await highlighter.highlightCodeSnippet({ code: source, language: "ts", theme: "dark" }),
    ).toEqual(highlighted);
  });

  it.each(["light", "dark"] as const)(
    "colors the same cold number token in %s mode",
    async (theme) => {
      vi.resetModules();
      const highlighter = await import("./shikiReviewHighlighter");
      const source = "const answer: number = 42;";
      const highlighted = await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme,
      });
      const number = highlighted.flat().find((token) => token.content === "42");
      expect(number?.color).toBeTruthy();
      expect(
        await highlighter.highlightCodeSnippet({ code: source, language: "ts", theme }),
      ).toEqual(highlighted);
    },
  );

  it("repeats a cold import and keeps the colored number", async () => {
    const source = "const answer: number = 42;";
    const load = async () => {
      vi.resetModules();
      const highlighter = await import("./shikiReviewHighlighter");
      const first = await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "dark",
      });
      const second = await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "dark",
      });
      expect(second).toEqual(first);
      expect(first.flat().find((token) => token.content === "42")?.color).toBeTruthy();
    };

    await load();
    await load();
  });

  it("highlights concurrent cold source and snippet calls", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";
    const [dark, light, snippet] = await Promise.all([
      highlighter.highlightSourceFile({ path: "example.ts", contents: source, theme: "dark" }),
      highlighter.highlightSourceFile({ path: "example.ts", contents: source, theme: "light" }),
      highlighter.highlightCodeSnippet({ code: source, language: "ts", theme: "dark" }),
    ]);

    expect(dark.flat().find((token) => token.content === "42")?.color).toBeTruthy();
    expect(light.flat().find((token) => token.content === "42")?.color).toBeTruthy();
    expect(dark.flat().find((token) => token.content === "42")?.color).not.toBe(
      light.flat().find((token) => token.content === "42")?.color,
    );
    expect(snippet).toEqual(dark);
  });

  it("finishes a cold line when the clock jumps past Shiki's default cutoff", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + ticks++ * 600;
    try {
      const highlighted = await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "dark",
      });
      const snippet = await highlighter.highlightCodeSnippet({
        code: source,
        language: "ts",
        theme: "light",
      });
      const sourceTokens = highlighted.flat();
      expect(sourceTokens.map((token) => token.content).join("")).toBe(source);
      expect(sourceTokens.some((token) => token.content === "= 42;")).toBe(false);
      expect(sourceTokens.find((token) => token.content === "42")?.color).toBeTruthy();
      expect(snippet.flat().find((token) => token.content === "42")?.color).toBeTruthy();
      expect(
        snippet
          .flat()
          .map((token) => token.content)
          .join(""),
      ).toBe(source);
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to plain tokens for an unknown language on a cold import", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";
    const highlighted = await highlighter.highlightSourceFile({
      path: "notes.not-a-language",
      contents: source,
      theme: "dark",
    });
    expect(highlighted).toEqual([[{ content: source, color: null, fontStyle: null }]]);
    expect(
      await highlighter.highlightCodeSnippet({
        code: source,
        language: "not-a-language",
        theme: "light",
      }),
    ).toEqual(highlighted);
  });

  it("keeps a long line plain on a cold import", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const highlighted = await highlighter.highlightSourceFile({
      path: "example.ts",
      contents: longLine,
      theme: "dark",
    });
    expect(highlighted).toEqual([[{ content: longLine, color: null, fontStyle: null }]]);
    expect(
      await highlighter.highlightCodeSnippet({ code: longLine, language: "ts", theme: "light" }),
    ).toEqual(highlighted);
  });
});

describe("highlightReviewSelectedLines", () => {
  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const lines: ReviewRenderableLineRow[] = [
      {
        kind: "line",
        id: "delete-1",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: { change: "add", tokenIndex: 0 },
      },
      {
        kind: "line",
        id: "add-1",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: { change: "delete", tokenIndex: 0 },
      },
    ];

    const highlighted = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/example-inline-diff.txt",
      lines,
      theme: "light",
    });

    expect(highlighted["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
  });
});

describe("highlightCodeSnippet", () => {
  it.each(["light", "dark"] as const)(
    "preserves diff-prefixed TSX review snippets in %s mode",
    async (theme) => {
      const lines = [
        "- onClick={() => submitOrder(cart)}",
        "+ onClick={handleSubmit}",
        "+ disabled={isSubmitting}",
      ];
      const highlighted = await highlightCodeSnippet({
        code: lines.join("\n"),
        language: "tsx",
        theme,
      });
      expect(highlighted.map((line) => line.map((token) => token.content).join(""))).toEqual(lines);
      expect(
        new Set(
          highlighted
            .flat()
            .map((token) => token.color)
            .filter(Boolean),
        ).size,
      ).toBeGreaterThan(1);
    },
  );

  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });
});
