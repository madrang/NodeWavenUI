// ESLint flat config: recommended TypeScript rules plus the stylistic set that matches the
// existing hand style (single quotes, semicolons, 2-space indent, 120-column lines), so the
// recurring formatting fixes stop depending on the editor.

import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * The local truthiness rule: a conditional that compares against `undefined`, `null`, `true`, or
 * `false` takes the simple form (`if (name)` or `if (!name)`), per the project convention. The
 * comparison and the truthiness differ when a false, empty, zero, or non-boolean value changes
 * the outcome — such a site carries an inline disable with its reason.
 */
const preferTruthiness = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Prefer the truthiness form over comparing against undefined, null, true, or false in a conditional.' },
    schema: [],
    messages: {
      truthiness:
        'Prefer the truthiness form (`if (name)` or `if (!name)`) over comparing against undefined, null, true, or false. Add an inline disable with a reason when a false, empty, zero, or non-boolean value changes the outcome.',
    },
  },
  create(context) {
    const isBareConstant = (node) =>
      (node.type === 'Identifier' && (node.name === 'undefined' || node.name === 'null')) ||
      (node.type === 'Literal' && (node.value === null || node.value === true || node.value === false));
    const isTest = (node) => {
      const parent = node.parent;
      if (parent === undefined || parent.type === 'ConditionalExpression') {
        return parent !== undefined && parent.test === node;
      }
      return (parent.type === 'IfStatement' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement') && parent.test === node;
    };
    return {
      BinaryExpression(node) {
        const equality = node.operator === '===' || node.operator === '!==' || node.operator === '==' || node.operator === '!=';
        if (equality && (isBareConstant(node.left) || isBareConstant(node.right)) && isTest(node)) {
          context.report({ node, messageId: 'truthiness' });
        }
      },
    };
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'plugins/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    plugins: { '@stylistic': stylistic, local: { rules: { 'prefer-truthiness': preferTruthiness } } },
    rules: {
      'local/prefer-truthiness': 'error',

      // Correctness guards that match the project conventions.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],

      // Style: the format the tree already carries.
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/semi': 'error',
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/max-len': ['error', { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true, ignoreComments: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/eol-last': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/operator-linebreak': ['error', 'after'],
      '@stylistic/padded-blocks': ['error', 'never'],
    },
  },
  {
    // The preloads and scripts run as plain CommonJS with both Node and browser globals:
    // the preloads use window.location and require('electron') together.
    files: ['src/preload/**/*.cjs', 'scripts/**/*.mjs'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2024, globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
