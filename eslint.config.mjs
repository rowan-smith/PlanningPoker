import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Prettier owns formatting. This config only covers code quality and structure;
// eslint-config-prettier (last) switches off anything that would fight Prettier.
export default tseslint.config(
  {
    ignores: ['.claude/', '.idea/', '**/node_modules/', '**/dist/', '**/build/', '**/coverage/'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    rules: {
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'max-depth': ['error', 4],
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',
      // Blank line after a completed control-flow block before the next statement.
      'padding-line-between-statements': [
        'error',
        {
          blankLine: 'always',
          prev: ['if', 'for', 'while', 'do', 'switch', 'try', 'block'],
          next: '*',
        },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  // Architecture boundaries (docs/ARCHITECTURE.md). Later blocks override earlier ones per file.
  {
    files: ['packages/domain/src/**', 'packages/contracts/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^[^.]',
              message: 'Domain and contracts are dependency-free: use relative imports only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/application/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@forge/*', 'react', 'react-*', '@planning-poker/ui', 'node:*'],
              message:
                'Application code must not depend on platforms, UI or Node APIs; use a port.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/persistence/**', 'packages/integrations/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', '@planning-poker/ui', '@planning-poker/contracts'],
              message: 'Adapters implement application ports; they do not depend on UI code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@forge/*', '@planning-poker/domain', '@planning-poker/application'],
              message: 'UI talks to the backend through contracts and PlanningPokerApi only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**', 'tests/**'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },
  {
    files: ['*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettierConfig,
  {
    // eslint-config-prettier disables `curly`; 'all' is safe alongside Prettier, so re-enable it.
    rules: {
      curly: ['error', 'all'],
    },
  },
);
