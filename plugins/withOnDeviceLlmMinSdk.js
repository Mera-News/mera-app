// The ML Kit GenAI Prompt API (Gemini Nano, modules/mera-on-device-llm) ships
// AARs that declare minSdk 26. The app stays on 24 so Android 7 users keep the
// app: the app manifest lets these libraries through, and the module checks
// SDK_INT >= 26 before any ML Kit call.
const { withAndroidManifest } = require('@expo/config-plugins');

const LIBRARIES = ['com.google.mlkit.genai.prompt', 'com.google.mlkit.genai.common'];

module.exports = function withOnDeviceLlmMinSdk(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const usesSdk = (manifest['uses-sdk'] ??= [{ $: {} }])[0];
    usesSdk.$ ??= {};
    const listed = (usesSdk.$['tools:overrideLibrary'] ?? '').split(',').filter(Boolean);
    usesSdk.$['tools:overrideLibrary'] = [...new Set([...listed, ...LIBRARIES])].join(',');
    return cfg;
  });
};
