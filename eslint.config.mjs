// ESLint flat config: recommended TypeScript rules plus the stylistic set that matches the
// existing hand style (single quotes, semicolons, 2-space indent, 120-column lines), so the
// recurring formatting fixes stop depending on the editor.

import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * The local truthiness rule: a conditional that compares against `undefined`, `null`, `true`, or
 * `false` takes the simple form (`if (name)` or `if (!name)`), per the project convention. A
 * comparison inside a `&&` or `||` chain of a conditional test counts too (`if (a && b !==
 * undefined)` reads `if (a && b)`). The comparison and the truthiness differ when a false,
 * empty, zero, or non-boolean value changes the outcome — such a site carries an inline disable
 * with its reason.
 */
const preferTruthiness = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Prefer the truthiness form over comparing against undefined, null, true, or false in a conditional or a logical chain of its test.' },
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
    // Walks up through `&&` and `||` chains: a comparison nested in the test of a conditional
    // still decides through truthiness, so it counts as part of the test.
    const isTest = (node) => {
      let current = node;
      while (current.parent !== undefined && current.parent.type === 'LogicalExpression') {
        current = current.parent;
      }
      const parent = current.parent;
      if (parent === undefined) {
        return false;
      }
      return (
        parent.type === 'IfStatement' ||
        parent.type === 'WhileStatement' ||
        parent.type === 'DoWhileStatement' ||
        parent.type === 'ConditionalExpression'
      ) && parent.test === current;
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

/**
 * The local logger-call rule: a call on the log hierarchy must end in one of the logger
 * methods. The child names of the chain stay free — the hierarchy proxy answers every name —
 * because the LogProxyType index is any-typed, only the final method name is checked. The
 * method list mirrors EventLogger of src/shared/logging.ts plus the raw print.
 */
const loggerCall = {
  meta: {
    type: 'problem',
    docs: { description: 'Checks that a call on the log hierarchy ends in one of the logger methods.' },
    schema: [],
    messages: {
      method:
        'The logger call ends in "{{name}}", which is no logger method. The level methods are: emergency, fatal, critical, error, warning, warn, notice, informative, info, debug, and trace.',
    },
  },
  create(context) {
    const methods = new Set([
      'emergency', 'fatal', 'critical', 'error', 'warning', 'warn',
      'notice', 'informative', 'info', 'debug', 'trace', 'print',
    ]);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') {
          return;
        }
        // Walk down the chain: only plain member chains rooted at `log` belong to the rule.
        // A call inside the chain stops the walk, because its answer is unknown.
        let current = callee.object;
        while (current.type === 'MemberExpression') {
          current = current.object;
        }
        if (current.type !== 'Identifier' || current.name !== 'log') {
          return;
        }
        let name = null;
        if (!callee.computed && callee.property.type === 'Identifier') {
          name = callee.property.name;
        } else if (callee.computed && callee.property.type === 'Literal' && typeof callee.property.value === 'string') {
          // A string-literal key counts as a name; any other computed key stays unchecked.
          name = callee.property.value;
        }
        if (name !== null && !methods.has(name)) {
          context.report({ node: callee.property, messageId: 'method', data: { name } });
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
    plugins: { '@stylistic': stylistic, local: { rules: { 'prefer-truthiness': preferTruthiness, 'logger-call': loggerCall } } },
    rules: {
      'local/prefer-truthiness': 'error',
      'local/logger-call': 'error',

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
