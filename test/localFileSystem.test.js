const { vscode } = require('./vscode-stub'); // must precede any src/ require
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalFileSystemProvider, toLocalUri, toDiskPath } = require('../src/localFileSystem');

const provider = new LocalFileSystemProvider();
let dir;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-file-bridge-'));
});

after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a local-file: URI carries the disk path unchanged', () => {
  const uri = toLocalUri('/Users/jp/.gitconfig');
  assert.equal(uri.scheme, 'local-file');
  assert.equal(toDiskPath(uri), '/Users/jp/.gitconfig');
});

test('stat and readFile report what is on disk', async () => {
  const file = path.join(dir, 'notes.md');
  await fsp.writeFile(file, 'alpha\nbravo\n');

  const stat = await provider.stat(toLocalUri(file));
  assert.equal(stat.type, vscode.FileType.File);
  assert.equal(stat.size, 12);
  assert.equal(stat.permissions, undefined, 'a writable file carries no Readonly flag');

  assert.equal(String(await provider.readFile(toLocalUri(file))), 'alpha\nbravo\n');
});

test('writeFile reaches the real file', async () => {
  const file = path.join(dir, 'saved.md');
  const uri = toLocalUri(file);

  await provider.writeFile(uri, Buffer.from('first\n'), { create: true, overwrite: false });
  assert.equal(await fsp.readFile(file, 'utf8'), 'first\n');

  await provider.writeFile(uri, Buffer.from('second\n'), { create: false, overwrite: true });
  assert.equal(await fsp.readFile(file, 'utf8'), 'second\n');
});

test('errno codes become the FileSystemError the editor expects', async () => {
  const missing = toLocalUri(path.join(dir, 'nope.md'));

  await assert.rejects(() => provider.readFile(missing), /FileNotFound/);
  await assert.rejects(() => provider.readFile(toLocalUri(dir)), /FileIsADirectory/);
  await assert.rejects(
    () => provider.writeFile(missing, Buffer.from('x'), { create: false, overwrite: true }),
    /FileNotFound/,
    'refuses to create when the editor did not ask for creation',
  );
});
