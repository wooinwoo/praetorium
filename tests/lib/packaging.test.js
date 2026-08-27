import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceExtensions = new Set(['.js', '.mjs', '.jsx', '.json', '.rs']);

function sourceFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : sourceExtensions.has(extname(child)) ? [child] : [];
  });
}

describe('Tauri runtime packaging', () => {
  it('packages every relative module imported by a packaged runtime file', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    const packaged = new Set(Object.keys(config.bundle.resources)
      .map(source => normalize(resolve(root, 'src-tauri', source))));
    const moduleFiles = [...packaged].filter(path => ['.js', '.mjs'].includes(extname(path)));
    const missing = [];

    for (const file of moduleFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const dependency = normalize(resolve(dirname(file), match[1]));
        if (!packaged.has(dependency)) missing.push(`${file.slice(root.length + 1)} -> ${dependency.slice(root.length + 1)}`);
      }
    }

    assert.deepEqual(missing, []);
  });

  it('resolves bundled resources through the platform-aware Tauri resource directory', () => {
    const source = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
    assert.match(source, /tauri::utils::platform::resource_dir/);
    assert.match(source, /context\.package_info\(\)/);
    assert.doesNotMatch(source, /current_exe\(\)[\s\S]{0,160}path\.parent/);
  });

  it('builds frontend resources before Tauri validates the bundle', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/build-installers.yml'), 'utf8');
    const frontendBuild = workflow.indexOf('run: npm run build');
    const tauriTest = workflow.indexOf('run: cargo test');
    assert.ok(frontendBuild >= 0);
    assert.ok(tauriTest >= 0);
    assert.ok(frontendBuild < tauriTest);
  });

  it('routes native notification activation back to the selected record', () => {
    const rust = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
    const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
    assert.match(cargo, /tauri-winrt-notification = "=0\.7\.3"/);
    assert.match(rust, /show_operator_notification/);
    assert.match(rust, /on_activated/);
    assert.match(rust, /emit\("operator-notification-open"/);
    assert.match(rust, /show_main_window\(&activation_app\)/);
  });

  it('keeps the Praetorium runtime independent from Cockpit', () => {
    const files = [
      ...sourceFiles(resolve(root, 'src')),
      ...sourceFiles(resolve(root, 'lib')),
      ...sourceFiles(resolve(root, 'routes')),
      ...sourceFiles(resolve(root, 'src-tauri/src')),
      resolve(root, 'server.js'),
      resolve(root, 'package.json'),
      resolve(root, 'src-tauri/tauri.conf.json'),
    ];
    const source = files.map(file => `${relative(root, file)}\n${readFileSync(file, 'utf8')}`).join('\n');
    assert.doesNotMatch(source, /cockpit|COCKPIT_|claude-code-cockpit|(?:localhost|127\.0\.0\.1):3847/i);
  });
});
