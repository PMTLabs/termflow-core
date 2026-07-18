const path = require('path');
const { execSync } = require('child_process');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

// Git tip of the source tree, captured when webpack starts. Surfaced by the dev-only
// BuildBadge (bottom-right) so a running build can be traced to its commit.
function gitInfo() {
  const run = (cmd, fallback) => {
    try {
      return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return fallback;
    }
  };
  return {
    sha: run('git rev-parse --short HEAD', 'unknown'),
    branch: run('git rev-parse --abbrev-ref HEAD', 'unknown'),
    subject: run('git log -1 --pretty=%s', ''),
    dirty: run('git status --porcelain', '') !== '',
  };
}

const GIT = gitInfo();
const IS_PROD = process.env.NODE_ENV === 'production';
const BUILD_TIME = new Date().toISOString();

module.exports = {
  mode: process.env.NODE_ENV || 'development',
  entry: ['./src/renderer/polyfills.js', './src/renderer/index.tsx'],
  target: 'web',
  externals: {
    // Exclude Node.js modules from being bundled
    fs: 'commonjs fs',
    path: 'commonjs path',
    os: 'commonjs os',
    child_process: 'commonjs child_process',
    crypto: 'commonjs crypto',
    stream: 'commonjs stream',
    util: 'commonjs util',
    net: 'commonjs net',
    tls: 'commonjs tls',
    dns: 'commonjs dns',
    http: 'commonjs http',
    https: 'commonjs https',
    zlib: 'commonjs zlib',
    // But allow events to be polyfilled for browser
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
            compilerOptions: {
              sourceMap: true
            }
          }
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
    fallback: {
      "events": require.resolve("events/"),
      "util": require.resolve("util/"),
      "buffer": require.resolve("buffer/"),
      "process": require.resolve("process/browser.js"),
    },
  },
  output: {
    filename: 'renderer.js',
    path: path.resolve(__dirname, 'dist/renderer'),
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.html',
    }),
    new webpack.DefinePlugin({
      global: 'globalThis',
      __DEV_BUILD__: JSON.stringify(!IS_PROD),
      __GIT_SHA__: JSON.stringify(GIT.sha),
      __GIT_BRANCH__: JSON.stringify(GIT.branch),
      __GIT_SUBJECT__: JSON.stringify(GIT.subject),
      __GIT_DIRTY__: JSON.stringify(GIT.dirty),
      __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    }),
    new webpack.ProvidePlugin({
      global: 'globalThis',
      process: 'process/browser.js',
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
  devServer: {
    port: 42010,
    hot: true,
    compress: true,
    historyApiFallback: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  devtool: process.env.NODE_ENV === 'development' ? 'cheap-module-source-map' : false,
};