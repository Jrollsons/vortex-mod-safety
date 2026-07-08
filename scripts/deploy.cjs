// Copies dist/ into the local Vortex plugins directory for manual testing.
const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');
const target = path.join(process.env.APPDATA, 'Vortex', 'plugins', 'vortex-mod-safety');

if (!fs.existsSync(path.join(dist, 'index.js'))) {
  console.error('dist/index.js not found - run `npm run build` first');
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(dist)) {
  fs.copyFileSync(path.join(dist, file), path.join(target, file));
}
console.log(`deployed to ${target}`);
