import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Muse repo lint config.
 *
 * Goal: catch genuine bug patterns and prevent regressions in dead-
 * import / never-reassigned-let hygiene. After the round 173 sweep
 * the codebase is at 0 warnings, so the dead-import + unused-vars
 * rules graduate from `warn` to `error` — any new violation now
 * blocks `pnpm lint` exit-0.
 *
 * The codebase is type-aware where it helps (typescript-eslint
 * recommended) but not project-aware (no `parserOptions.project`) —
 * lighter to run, and `pnpm check` covers full type verification.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.claude/worktrees/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.muse/**",
      "**/.muse-dev/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/scripts/**",
      "harness/runner/**",
      "apps/desktop/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "@typescript-eslint/no-namespace": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-empty-pattern": "error",
      "no-control-regex": "off",
      "no-useless-escape": "error",
      "no-unsafe-finally": "error",
      "no-async-promise-executor": "error",
      "no-prototype-builtins": "error",
      "no-debugger": "error",
      "no-eval": "error",
      "no-restricted-imports": ["error", {
        paths: [{
          message: "The Attunement host seam is restricted to the five audited production composition roots.",
          name: "@muse/attunement/host"
        }]
      }],
      "no-with": "error",
      "prefer-const": "error"
    }
  },
  {
    files: [
      "apps/api/src/attunement-routes.ts",
      "apps/api/src/tasks-routes.ts",
      "apps/cli/src/commands-attunement.ts",
      "apps/cli/src/commands-tasks.ts",
      "packages/autoconfigure/src/loopback-tools.ts"
    ],
    rules: { "no-restricted-imports": "off" }
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  }
);
