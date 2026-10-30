// The machine says no before a human has to. Run: npm run lint
// Focus: XSS. The page keeps a GitHub token in localStorage, so HTML built from data must go through esc().
// The CSP in index.html (script-src 'self') is the second wall; this is the first.
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import js from "@eslint/js";
import nounsanitized from "eslint-plugin-no-unsanitized";
import globals from "globals";

export default [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  // 例外は 1 行ずつ、規則名と理由(-- の後)を書く。要らなくなった例外は止める
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: ["**/*.js"],
    plugins: { "no-unsanitized": nounsanitized, "@eslint-community/eslint-comments": comments },
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals.browser } },
    rules: {
      // esc() turns < > & " ' into entities (app.js). Anything else put into HTML is reported.
      "no-unsanitized/method": ["error", { escape: { methods: ["esc"] } }],
      "no-unsanitized/property": ["error", { escape: { methods: ["esc"] } }],
      // 取得に失敗したら(オフラインなど)前の表示や既定値のまま続ける、がこの画面の決まり。空の catch はその印
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/disable-enable-pair": "error",
    },
  },
  {
    files: ["app.js"],
    // gh.js is loaded first by a plain <script> tag and shares the global scope.
    languageOptions: { globals: { GH: "readonly" } },
  },
  {
    files: ["sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: { sourceType: "module" },
  },
];
