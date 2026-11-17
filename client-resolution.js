// Where mera-news-client is installed. Babel, Metro, Jest and the scripts read it from here only.
// MERA_CLIENT_ROOT points Jest and the scripts at another copy (a planted scratch copy in a test);
// a bundle must never carry one, so Metro refuses it and Babel refuses it in a production build.
const path = require('path');

const APP_ROOT = __dirname;
const INSTALLED_CLIENT_ROOT = path.dirname(
  require.resolve('mera-news-client/package.json', { paths: [APP_ROOT] }),
);
const CLIENT_ROOT = process.env.MERA_CLIENT_ROOT
  ? path.resolve(process.env.MERA_CLIENT_ROOT)
  : INSTALLED_CLIENT_ROOT;

function refuseClientOverride(tool) {
  if (process.env.MERA_CLIENT_ROOT) {
    throw new Error(`MERA_CLIENT_ROOT is set, but ${tool} only uses the installed mera-news-client. Unset it.`);
  }
}

module.exports = { APP_ROOT, INSTALLED_CLIENT_ROOT, CLIENT_ROOT, refuseClientOverride };
