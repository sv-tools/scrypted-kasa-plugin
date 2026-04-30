import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// We deliberately don't use `eslint-config-prettier`: typescript-eslint's `recommended`
// preset focuses on code-quality rules, not style. Prettier already owns formatting via
// `npm run fmt` / `fmt:check`, and there's nothing in the rule set below that fights it.
// Skipping the dep also sidesteps the known eslint-config-prettier supply-chain compromise.
export default tseslint.config(
    {
        ignores: ['node_modules/', 'out/', 'build/', 'dist/'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // Allow `any` — used intentionally for kasa sysinfo (untyped JSON shape varies
            // per device family) and for narrow casts where TypeScript can't see through
            // the runtime tag (e.g. `kasaClass`).
            '@typescript-eslint/no-explicit-any': 'off',

            // Treat `_`-prefixed args/vars as intentionally unused (matches the convention
            // we already use for ignored handler params like `_options`, `_id`, `_nativeId`).
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],

            // Empty catch blocks are a deliberate teardown idiom in this codebase: e.g.
            // `try { socket.close(); } catch {}` — best-effort, ignore failure. Don't nag.
            'no-empty': ['warn', { allowEmptyCatch: true }],
        },
    },
);
