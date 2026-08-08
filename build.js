const fs = require('fs-extra');
const JavaScriptObfuscator = require('javascript-obfuscator');
const path = require('path');

const srcDir = __dirname;
const distDir = path.join(__dirname, 'dist');

const filesToObfuscate = ['popup.js', 'background.js', 'content.js'];
const filesToCopy = ['popup.html', 'popup.css', 'manifest.json', 'icon.png', 'README.md', 'VERSION.md'];

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
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        debugProtection: true,
        debugProtectionInterval: 4000,
        disableConsoleOutput: true,
        identifierNamesGenerator: 'hexadecimal',
        log: false,
        numbersToExpressions: true,
        renameGlobals: false,
        selfDefending: true,
        simplify: true,
        splitStrings: true,
        splitStringsChunkLength: 10,
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayCallsTransformThreshold: 0.5,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 1,
        stringArrayWrappersChainedCalls: true,
        stringArrayWrappersParametersMaxCount: 2,
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

  // Copy images folder if it exists
  const imgDirSrc = path.join(srcDir, 'images');
  if (await fs.pathExists(imgDirSrc)) {
    console.log('Copying images directory...');
    await fs.copy(imgDirSrc, path.join(distDir, 'images'));
  }

  console.log('Build completed! 插件分发包已在 dist/ 目录生成。');
}

build().catch(console.error);
