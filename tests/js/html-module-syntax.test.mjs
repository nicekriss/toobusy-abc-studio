import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The editor's main code lives in an inline <script type="module"> inside
// index.html. The esbuild step only sees .js files, so a syntax error there
// would pass CI while the studio refused to open. Check every inline script.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function htmlFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function inlineScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    found.push({ module: /\btype\s*=\s*["']?module/i.test(attrs), source: match[2] });
  }
  return found;
}

function syntaxError(source, module) {
  const dir = mkdtempSync(join(tmpdir(), 'html-script-'));
  try {
    const file = join(dir, module ? 'inline.mjs' : 'inline.cjs');
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return run.status === 0 ? null : (run.stderr || 'syntax check failed').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the checker actually rejects broken code', () => {
  // Without this, a checker that silently passes everything would look green.
  assert.ok(syntaxError('const a = ;', true));
  assert.equal(syntaxError('import x from "y"; export const a = await Promise.resolve(x);', true), null);
});

test('every inline script in the shipped HTML parses', () => {
  const files = htmlFiles(join(ROOT, 'js'));
  assert.ok(files.length > 0, 'no HTML found under js/');
  let checked = 0;
  for (const file of files) {
    for (const [i, script] of inlineScripts(readFileSync(file, 'utf8')).entries()) {
      const error = syntaxError(script.source, script.module);
      assert.equal(error, null, relative(ROOT, file) + ' inline script #' + (i + 1) + '\n' + error);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no inline scripts found; the extraction pattern may be broken');
});
