import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let installed = process.env.PI_PACKAGE_DIR;
if (!installed) {
  let dir = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && JSON.parse(readFileSync(join(dir, 'package.json'))).name === '@earendil-works/pi-coding-agent') { installed = dir; break; }
    dir = dirname(dir);
  }
}
if (!installed) throw Error('Set PI_PACKAGE_DIR to the installed pi-coding-agent package');
export const piDir = installed;
export const requirePi = createRequire(join(piDir, 'package.json'));
export const tuiPath = requirePi.resolve('@earendil-works/pi-tui');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(plugin, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ['node'],
      paths: {
        '@earendil-works/pi-coding-agent': [join(piDir, 'dist/index.d.ts')],
        '@earendil-works/pi-tui': [tuiPath.replace(/\.js$/, '.d.ts')],
      },
    }, include: ['*.ts'],
  }, null, 2) + '\n');
  console.log('Generated local tsconfig.json from installed pi: ' + piDir);
}
