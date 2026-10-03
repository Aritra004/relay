import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [{
      group: ["@/server/**", "**/server/**"],
      message: "UI and browser modules must use HTTP contracts, never import the server layer.",
    }] }] },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [{
      group: ["@/server/db/**", "**/server/db/**"],
      message: "Routes and React components must use services, never the database layer directly.",
    }] }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "test-results/**",
    "playwright-report/**",
    "public/sw.js",
  ]),
]);

export default eslintConfig;
