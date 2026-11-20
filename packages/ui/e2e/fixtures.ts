import { test as base, expect, type Page } from "@playwright/test";

export interface ConsoleWatcher {
  allowError: (pattern: string | RegExp) => void;
  errors: string[];
}

export const test = base.extend<{
  consoleWatcher: ConsoleWatcher;
}>({
  consoleWatcher: [
    async ({ page, context }, use) => {
      const errors: string[] = [];
      const allowed: (string | RegExp)[] = [/favicon\.ico/];

      const attachToPage = (p: Page) => {
        p.on("console", (msg) => {
          const type = msg.type();
          if (type === "error" || type === "warning") {
            errors.push(`[${type}] ${msg.text()}`);
          }
        });

        p.on("pageerror", (err) => {
          errors.push(`[pageerror] ${err.message}`);
        });
      };

      attachToPage(page);
      context.on("page", (newPage) => {
        attachToPage(newPage);
      });

      await use({
        allowError: (pattern: string | RegExp) => {
          allowed.push(pattern);
        },
        errors,
      });

      const unhandled = errors.filter((entry) => {
        return !allowed.some((pattern) =>
          typeof pattern === "string" ? entry.includes(pattern) : pattern.test(entry),
        );
      });

      expect(
        unhandled,
        `Console errors/warnings found in test:\n${unhandled.join("\n")}`,
      ).toHaveLength(0);
    },
    { auto: true },
  ],
});

export { expect, type Page };
