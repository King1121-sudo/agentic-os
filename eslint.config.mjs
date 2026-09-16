// ESLint flat config — one entry point for the whole workspace.
//
// Design intent: this is a GATE, not a style police. It must be green on the
// current codebase so CI can start enforcing today, so pre-existing debt is
// surfaced as `warn` (visible in every run, tracked in the review backlog)
// while anything that is a genuine correctness bug is `error`.
//
// Run:  npm run lint        (see package.json)
//
// THE RATCHET: `npm run lint` passes `--max-warnings=884`, the exact warning
// count at the time this gate landed. New warnings fail CI; existing debt does
// not. As debt is paid down, LOWER that number — it is the only thing stopping
// the count from creeping back up. Current composition of the 884:
//   ~869  @typescript-eslint/no-explicit-any   (typing the DataPort surface)
//     11  react-hooks compiler advisories      (need a UI-behaviour pass)
//     ~5  prefer-const / eqeqeq / no-empty
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Rules shared by every TypeScript file in the workspace. */
const sharedTsRules = {
  // 448 pre-existing `any` escapes. Downgraded to warn deliberately: turning
  // this to `error` would require typing the whole DataPort surface first.
  // Every new `any` still shows up in the lint output.
  '@typescript-eslint/no-explicit-any': 'warn',

  // Real bugs — an unused import or binding is dead code.
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
    ignoreRestSiblings: true,
  }],

  // `catch {}` with no handler and no comment hides failures. The codebase has
  // 65 `catch(() => {})` sites; this keeps them visible rather than invisible.
  'no-empty': ['warn', { allowEmptyCatch: false }],

  // console is the logging mechanism for this project (boot banner, oauth
  // diagnostics) — there is no logger abstraction to prefer.
  'no-console': 'off',

  // Fastify/Express handlers and the runtime's fire-and-forget drive loop
  // legitimately return promises from void positions.
  '@typescript-eslint/no-misused-promises': 'off',

  eqeqeq: ['warn', 'smart'],
  'prefer-const': 'warn',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/web/chrome-profile/**',
      'apps/web/public/sw.js',
    ],
  },

  // ── API + contracts (Node) ────────────────────────────────────────────────
  {
    files: ['apps/api/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      ...sharedTsRules,

      // The API compiles to CommonJS (`module: commonjs` in tsconfig.base.json),
      // so `require()` is the native mechanism here — and it is load-bearing:
      // every call site lazy-loads an OPTIONAL dependency so the kernel still
      // boots with zero drivers installed (`redis`, `pg`, `node:sqlite`) or
      // defers a capability until it is actually used (`child_process` for
      // shell.run, `dotenv` for .env). Converting these to static imports would
      // make those dependencies mandatory. The rule is ESM-oriented; it does
      // not apply to this package.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ── Web app (browser + React) ─────────────────────────────────────────────
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...sharedTsRules,
      // The hooks rules are the highest-value checks in the web app — the
      // ExecutionStore and Shell both lean on effect dependencies.
      ...(reactHooks.configs['recommended-latest']?.rules ?? reactHooks.configs.recommended.rules),

      // React Compiler-era advisories (react-hooks v7). These flag real
      // patterns — `setState` synchronously in an effect, `Date.now()` during
      // render, reading/writing a ref in a render body — but every fix changes
      // component behaviour, and the web app has no UI test coverage to catch a
      // regression. They are tracked debt, not ignorable noise: kept as `warn`
      // so they stay visible in every run. See the review backlog.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },

  // ── Config + build scripts ────────────────────────────────────────────────
  {
    files: ['**/*.config.{js,mjs,cjs,ts}', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
