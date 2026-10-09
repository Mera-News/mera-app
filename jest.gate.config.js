const config = require('./jest.config.js');

// The per-file deletion gate (DECISIONS "Coverage gate") runs with this config
// before and after each P2 deletion. The shipped coverage settings in
// jest.config.js stay unchanged until P5.
module.exports = {
  ...config,
  // The global floors in jest.config.js describe the shipped glob list, not this
  // wider one; the gate compares per-file numbers, so it must not exit 1 on them.
  coverageThreshold: {},
  collectCoverageFrom: [
    ...config.collectCoverageFrom.filter(
      (g) => g !== '!lib/hooks/**' && g !== '!lib/apollo-client.ts',
    ),
    'lib/**/*.tsx',
    'lib/hooks/**/*.{ts,tsx}',
    'lib/apollo-client.ts',
    'components/custom/**/use*.{ts,tsx}',
    'components/custom/**/*.ts',
  ],
};
