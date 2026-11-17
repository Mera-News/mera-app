// Jest resolver: a bare import made from a mera-news-client file resolves as if the app made it, so a
// node_modules beside the client (a scratch copy, a nested install) never supplies a second copy of a
// peer such as graphql, zustand or WatermelonDB. Everything else is Jest's own resolution. Metro has
// the same rule.
const fs = require('fs');
const path = require('path');
const { CLIENT_ROOT } = require('../../client-resolution');

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const CLIENT = real(CLIENT_ROOT) + path.sep;

module.exports = (request, options) => {
  const bare = !request.startsWith('.') && !path.isAbsolute(request);
  if (bare && (real(options.basedir) + path.sep).startsWith(CLIENT)) {
    return options.defaultResolver(request, { ...options, basedir: options.rootDir });
  }
  return options.defaultResolver(request, options);
};
