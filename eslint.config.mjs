// Проверка кода: npx eslint (или node tools/build.mjs). Глобальные имена браузера перечислены явно — без зависимостей.
const browser = Object.fromEntries(("window document navigator localStorage sessionStorage location history fetch setTimeout clearTimeout setInterval clearInterval " +
  "requestAnimationFrame requestIdleCallback console URL URLSearchParams Blob File FileReader Image Headers Request Response crypto TextEncoder TextDecoder atob btoa " +
  "Notification IntersectionObserver MutationObserver NodeFilter Event TouchEvent Touch MediaRecorder AudioContext matchMedia performance visualViewport " +
  "AbortController AbortSignal XMLHttpRequest DataView Uint8Array caches self clients getComputedStyle innerWidth innerHeight screen CustomEvent HTMLElement " +
  "FormData Option maplibregl supabase turnstile").split(/\s+/).map((k) => [k, "readonly"]));
export default [
  { ignores: ["node_modules/**", "supabase/**", "tools/**", "js/*.min.js"] },
  {
    files: ["js/**/*.js", "sw.js", "src/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browser },
    rules: {
      "no-undef": "error", "no-redeclare": "error", "no-dupe-keys": "error", "no-unreachable": "error", "no-const-assign": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }], "no-self-assign": "error", "no-dupe-else-if": "error"
    }
  }
];
