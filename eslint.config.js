import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Browser globals
        console: "readonly",
        document: "readonly",
        atob: "readonly",
        btoa: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        self: "readonly",
        // WebExtension globals
        browser: "readonly",
        chrome: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/", "web-ext-artifacts/", "coverage/", "tests/"],
  },
];
