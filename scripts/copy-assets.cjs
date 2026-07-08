// Copies static assets (info.json) into dist/ after webpack runs.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'info.json'), path.join(dist, 'info.json'));
console.log('copied info.json -> dist/');
