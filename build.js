const fs = require('fs-extra');
const JavaScriptObfuscator = require('javascript-obfuscator');
const path = require('path');

const srcDir = __dirname;
const distDir = path.join(__dirname, 'dist');

const filesToObfuscate = ['popup.js', 'background.js', 'content.js', '1688_sku_collector.js'];
const filesToCopy = ['popup.html', 'popup.css', 'manifest.json', 'VERSION.md'];

async function build() {
  console.log('Cleaning dist directory...');
  await fs.remove(distDir);
  await fs.ensureDir(distDir);

  // Obfuscate JS files
  for (const file of filesToObfuscate) {
    console.log(`Obfuscating ${file}...`);
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(distDir, file);
    if (await fs.pathExists(srcPath)) {
      const code = await fs.readFile(srcPath, 'utf8');
      const obfuscated = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal',
        log: false,
        numbersToExpressions: false,
        renameGlobals: false,
        selfDefending: false,
        simplify: true,
        splitStrings: false,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 1,
        stringArrayWrappersType: 'variable',
        stringArrayThreshold: 0.75,
        unicodeEscapeSequence: false
      });
      await fs.writeFile(destPath, obfuscated.getObfuscatedCode(), 'utf8');
    }
  }

  // Copy static files
  for (const file of filesToCopy) {
    console.log(`Copying ${file}...`);
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(distDir, file);
    if (await fs.pathExists(srcPath)) {
      await fs.copy(srcPath, destPath);
    }
  }

  // Copy icons folder if it exists
  const iconsDirSrc = path.join(srcDir, 'icons');
  if (await fs.pathExists(iconsDirSrc)) {
    console.log('Copying icons directory...');
    await fs.copy(iconsDirSrc, path.join(distDir, 'icons'));
  }

  // Copy images folder if it exists
  const imgDirSrc = path.join(srcDir, 'images');
  if (await fs.pathExists(imgDirSrc)) {
    console.log('Copying images directory...');
    await fs.copy(imgDirSrc, path.join(distDir, 'images'));
  }

  console.log('Build completed! 插件分发包已在 dist/ 目录生成。');
}

build().catch(console.error);
