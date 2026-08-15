// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, setValue } from "./form-test-helpers.tsx";
import { PromptMarkdownPreview } from "./prompt-markdown-preview.tsx";
import { SessionPromptField } from "./session-prompt-field.tsx";

describe("PromptMarkdownPreview", () => {
  it("safely renders common prompt markdown", () => {
    const value = [
      "# Main **goal**",
      "## Details",
      "### Notes",
      "- run `pnpm check`",
      "* inspect [docs](https://example.com/docs)",
      "> preserve user changes",
      "",
      "Reject [script](javascript:alert) and [relative](docs/readme.md) links.",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");
    const view = mountForm(<PromptMarkdownPreview value={value} />);
    expect(view.container.querySelector("h2")?.textContent).toBe("Main goal");
    expect(view.container.querySelector("h3")?.textContent).toBe("Details");
    expect(view.container.querySelector("h4")?.textContent).toBe("Notes");
    expect(view.container.querySelector("strong")?.textContent).toBe("goal");
    expect(view.container.querySelector("code")?.textContent).toBe("pnpm check");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    expect(view.container.querySelector("blockquote")?.textContent).toBe("preserve user changes");
    expect(view.container.querySelector("pre")?.textContent).toBe("const ok = true;");
    view.unmount();
  });

  it("renders empty content and an unterminated code fence", () => {
    const empty = mountForm(<PromptMarkdownPreview value="  " />);
    expect(empty.container.textContent).toBe("Nothing to preview yet.");
    empty.unmount();

    const code = mountForm(<PromptMarkdownPreview value={"```\nhello"} />);
    expect(code.container.querySelector("pre")?.textContent).toBe("hello");
    code.unmount();
  });
});

describe("SessionPromptField", () => {
  it("switches between editing and a live preview while retaining form input", () => {
    const view = mountForm(<SessionPromptField />);
    const textarea = field<HTMLTextAreaElement>(view.container, "create-session-prompt");
    const previewButton = field<HTMLButtonElement>(
      view.container,
      "create-session-prompt-preview-toggle",
    );
    expect(previewButton.disabled).toBe(true);
    setValue(textarea, "# Fix **tests**");
    expect(previewButton.disabled).toBe(false);

    act(() => previewButton.click());
    expect(textarea.hidden).toBe(true);
    expect(textarea.disabled).toBe(true);
    expect(textarea.required).toBe(false);
    expect(field(view.container, "create-session-prompt-preview").textContent).toBe("Fix tests");
    expect(textarea.value).toBe("# Fix **tests**");
    expect(
      view.container.querySelector<HTMLInputElement>('input[type="hidden"][name="prompt"]')?.value,
    ).toBe("# Fix **tests**");

    act(() => field(view.container, "create-session-prompt-write").click());
    expect(textarea.hidden).toBe(false);
    expect(textarea.disabled).toBe(false);
    expect(textarea.required).toBe(true);
    expect(view.container.querySelector('input[type="hidden"][name="prompt"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="create-session-prompt-preview"]')).toBeNull();
    view.unmount();
  });

  it("preserves a Clone & Edit prompt when previewing", () => {
    const view = mountForm(<SessionPromptField initialValue="# Existing **prompt**" />);
    const textarea = field<HTMLTextAreaElement>(view.container, "create-session-prompt");
    expect(textarea.value).toBe("# Existing **prompt**");

    act(() => field(view.container, "create-session-prompt-preview-toggle").click());
    expect(field(view.container, "create-session-prompt-preview").textContent).toBe(
      "Existing prompt",
    );
    expect(textarea.value).toBe("# Existing **prompt**");
    view.unmount();
  });
});
