const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

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