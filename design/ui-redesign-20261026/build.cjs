// Bundle the review prototype into one portable HTML file. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const logo = fs.readFileSync(path.join(dir, '../../assets/logo-64.png')).toString('base64');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8')
  .replaceAll('../../assets/logo-64.png', 'data:image/png;base64,' + logo)
  .replaceAll('</script', '<\\/script');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="style.css">', '<style>' + css + '</style>')
  .replace('<script src="app.js"></script>', '<script>' + js + '</script>')
  .replace('href="index.html"', 'href="ClipRelay-design.html"');
fs.writeFileSync(path.join(dir, 'ClipRelay-design.html'), html);
console.log('Built ClipRelay-design.html (portable, offline, example data only)');
