const path = require('path');

module.exports = {
  mode: 'production',
  target: 'electron-renderer',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: { type: 'commonjs2' },
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  // vortex-api (and the UI libraries it re-exports) are injected by Vortex at
  // runtime and must never be bundled.
  externals: {
    'vortex-api': 'commonjs vortex-api',
    react: 'commonjs react',
    'react-dom': 'commonjs react-dom',
    'react-bootstrap': 'commonjs react-bootstrap',
    'react-redux': 'commonjs react-redux',
    'react-i18next': 'commonjs react-i18next',
    redux: 'commonjs redux',
    'redux-act': 'commonjs redux-act',
    bluebird: 'commonjs bluebird',
  },
  devtool: 'source-map',
  optimization: {
    minimize: false,
  },
};
