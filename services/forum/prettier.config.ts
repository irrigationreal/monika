import type { Config } from 'prettier';

const config: Config = {
  bracketSpacing: true,
  htmlWhitespaceSensitivity: 'css',
  importOrder: [
    '^node:(.*)$',
    '<BUILTIN_MODULES>',
    '^vue(.*)$',
    '^react(.*)$',
    '',
    '<THIRD_PARTY_MODULES>',
    '',
    '^@irrigationreal/(.*)$',
    '',
    '^(#app|#tests|@/)(/.*)$',
    '',
    '^[./]',
    '^[../]',
    '',
    '<TYPES>',
    '',
    '<TYPES>^[.]',
    '',
    '(.css|.scss|.sass|.less|.styl)$',
  ],
  importOrderCaseSensitive: true,
  importOrderParserPlugins: ['typescript', 'jsx', 'decorators-legacy'],
  insertPragma: false,
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  printWidth: 120,
  proseWrap: 'always',
  quoteProps: 'as-needed',
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'es5',
  useTabs: false,
  overrides: [
    {
      files: ['*.json', '*.code-workspace'],
      options: {
        quoteProps: 'as-needed',
        singleQuote: false,
        trailingComma: 'none',
      },
    },
  ],
};

export default config;
