// On-device AI is iOS-only (ON_DEVICE_BETA_PLATFORMS), so Android skips llama.rn's native build.
module.exports = {
  dependencies: {
    'llama.rn': { platforms: { android: null } },
  },
};
