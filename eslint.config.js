import js from "@eslint/js";
export default [
  { ignores: ["node_modules/**", "runtime/**", "output/**", "reference/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
];
