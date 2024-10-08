module.exports = {
  trailingComma: 'all',
  printWidth: 120,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  bracketSpacing: false,
  endOfLine: 'lf',
  arrowParens: 'avoid',

  overrides: [
    {
      files: ['*.yml', '*.yaml'],
      options: {
        tabWidth: 2,
      },
    },
    {
      files: ['*.md'],
      options: {
        tabWidth: 2,
        proseWrap: 'always',
      },
    },
  ],
};
