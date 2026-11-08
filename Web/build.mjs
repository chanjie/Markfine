import { build } from 'esbuild';
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inputID = process.env.MARKFINE_INPUT_ID;
const output = process.env.MARKFINE_WEB_OUTPUT;
function controlled(path) {
  if (!path || !resolve(path).startsWith(resolve(root, 'Build') + '/')) throw new Error('Output must be inside Build/; use python3 Scripts/build.py');
  return resolve(path);
}
if (!/^[a-f0-9]{64}$/.test(inputID ?? '')) throw new Error('Missing build input ID; use python3 Scripts/build.py');
const outdir = controlled(output);
await mkdir(outdir, { recursive: true });
for (const name of ['index.html', 'style.css']) await copyFile(resolve(here, name), resolve(outdir, name));
for (const name of ['paper-texture.png', 'kraft-texture.png']) await copyFile(resolve(here, 'textures', name), resolve(outdir, name));
const result = await build({
  absWorkingDir: here, entryPoints: ['src/app.ts'], outfile: resolve(outdir, 'app.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'safari26',
  minify: true, legalComments: 'external', metafile: true, logLevel: 'info'
});
await writeFile(resolve(outdir, '../app-bundle.json'), JSON.stringify(result.metafile, null, 2) + '\n');
const diagrams = await build({ absWorkingDir: here, entryPoints: ['src/mermaid-runtime.ts'], outfile: resolve(outdir, 'mermaid-runtime.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'safari26', minify: true, legalComments: 'external', metafile: true, logLevel: 'info' });
await writeFile(resolve(outdir, '../mermaid-bundle.json'), JSON.stringify(diagrams.metafile, null, 2) + '\n');
const lock = JSON.parse(await readFile(resolve(here, 'package-lock.json'), 'utf8'));
const bundledPackages = [...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(diagrams.metafile.inputs)].flatMap(path => {
  const parts = path.split('/'), index = parts.lastIndexOf('node_modules');
  if (index < 0) return [];
  return [parts.slice(parts.indexOf('node_modules'), index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/')];
}))].sort();
const dependencies = [], notices = ['Markfine — bundled dependency licenses and notices.\n'];
for (const path of bundledPackages) {
  const entry = lock.packages[path];
  if (!entry) throw new Error(`Bundle input missing from lockfile: ${path}`);
  const directory = resolve(here, path);
  const files = await readdir(directory);
  const installed = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (installed.version !== entry.version) throw new Error(`Installed version differs from lockfile: ${path}`);
  const licenseFiles = [];
  for (const name of files.filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)).sort()) {
    const contents = await readFile(resolve(directory, name), 'utf8');
    licenseFiles.push({ name, sha256: createHash('sha256').update(contents).digest('hex') });
    notices.push(`\n===== ${path}@${entry.version} / ${name} =====\n${contents}\n`);
  }
  let license = entry.license;
  if (path === 'node_modules/khroma' && !license) {
    const contents = await readFile(resolve(directory, 'license'), 'utf8');
    if (contents.startsWith('The MIT License (MIT)')) license = 'MIT';
  }
  if (!license || !licenseFiles.length) throw new Error(`License review required before packaging: ${path}`);
  const selectedLicense = path === 'node_modules/elkjs' ? 'EPL-2.0' : path === 'node_modules/dompurify' ? 'Apache-2.0' : license;
  dependencies.push({ package: path.replace('node_modules/', ''), version: entry.version, license, selectedLicense,
    integrity: entry.integrity, licenseFiles });
}
// Attribute the actual runtime bundle inputs, not unused development dependencies.
await writeFile(resolve(outdir, 'dependencies.json'), JSON.stringify(dependencies, null, 2) + '\n');
await writeFile(resolve(outdir, 'ThirdPartyNotices.txt'), notices.join(''));
const config = JSON.parse(await readFile(resolve(root, 'Config/Build.json'), 'utf8'));
await writeFile(resolve(outdir, 'build-info.json'), JSON.stringify({ ...config, inputID }, null, 2) + '\n');
const manifest = { format: 1, inputID, files: {} };
for (const name of (await readdir(outdir)).sort()) {
  const path = relative(outdir, resolve(outdir, name));
  if (isAbsolute(path) || path.startsWith('..') || name === 'manifest.json') throw new Error('Unexpected output file');
  manifest.files[name] = createHash('sha256').update(await readFile(resolve(outdir, name))).digest('hex');
}
await writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
