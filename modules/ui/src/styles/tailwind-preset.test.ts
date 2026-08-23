import { describe, expect, it } from "vitest";

import { preset } from "./tailwind-preset.ts";

describe("shared Tailwind preset", () => {
  it("keeps both applications on the complete shared semantic token set", () => {
    expect(preset.darkMode).toBe("class");
    expect(preset.content).toEqual(["./src/**/*.{ts,tsx}", "../../modules/ui/src/**/*.{ts,tsx}"]);
    expect(preset.plugins).toEqual([]);
    expect(preset.theme?.extend).toMatchObject({
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        timeout: {
          DEFAULT: "hsl(var(--timeout))",
          foreground: "hsl(var(--timeout-foreground))",
        },
        terminal: {
          DEFAULT: "hsl(var(--terminal-background))",
          foreground: "hsl(var(--terminal-foreground))",
        },
        ring: "hsl(var(--ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    });
  });
});
