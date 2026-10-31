module.exports = function (api) {
  api.cache(true);

  return {
    // SDK 58's preset runs the decorators transform itself, after TS type
    // stripping; a separate decorators plugin here runs first and breaks
    // WatermelonDB's `@field x!: T` model fields.
    presets: [['babel-preset-expo', { decorators: { legacy: true } }], 'nativewind/babel'],

    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],

          alias: {
            '@': './',
            'tailwind.config': './tailwind.config.js',
          },
        },
      ],
      'react-native-worklets/plugin',
    ],

    // Test-only: Jest runs in CommonJS, but babel-preset-expo does not rewrite
    // dynamic `import()` for the jest caller, so `await import(...)` throws
    // "dynamic import callback invoked without --experimental-vm-modules".
    // This plugin rewrites `import()` -> require()-based promise in the test env
    // only. Metro (development/production) never applies this block.
    env: {
      test: {
        plugins: ['@babel/plugin-transform-modules-commonjs'],
      },
    },
  };
};
