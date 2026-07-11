const path = require('path');

// Force a SINGLE React instance across the monitor's entire webpack bundle.
//
// Why: the repo uses bun's "hoisted" workspace linker. The root app needs
// React 19, the monitor needs React 18, so bun keeps React 18 nested under
// terminal-monitor/node_modules and hoists React 19 to the root. Monitor-only
// UI deps (@mui/material, @emotion/react) get hoisted to the ROOT node_modules
// too — and since they have no nested React, they resolve the root's React 19.
// That mixes React 18 (the app + its ReactDOM root) with React 19 (MUI) in one
// tree, which throws at render time:
//   "Objects are not valid as a React child (found: object with keys
//    {$$typeof, type, key, props, _owner, _store})"
//
// Aliasing react / react-dom (prefix match, so react/jsx-runtime and
// react-dom/client are covered too) to the monitor's own React 18 makes MUI and
// everything else resolve that single copy. MUI v5 / emotion 11 fully support
// React 18, so pinning to 18 is the low-risk choice.
const reactDir = path.dirname(
  require.resolve('react/package.json', { paths: [__dirname] })
);
const reactDomDir = path.dirname(
  require.resolve('react-dom/package.json', { paths: [__dirname] })
);

module.exports = {
  webpack: {
    alias: {
      react: reactDir,
      'react-dom': reactDomDir,
    },
    configure: (webpackConfig) => {
      // CRA's ModuleScopePlugin forbids imports resolving outside src/. The
      // react/react-dom aliases above point into node_modules, so the guard
      // rejects them ("falls outside of the project src/ directory"). Drop the
      // plugin — it's only a convenience guardrail, not a correctness control.
      webpackConfig.resolve.plugins = (
        webpackConfig.resolve.plugins || []
      ).filter(
        (p) => !(p && p.constructor && p.constructor.name === 'ModuleScopePlugin')
      );
      return webpackConfig;
    },
  },
};
