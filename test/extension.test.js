const { vscode, recorded, reset } = require('./vscode-stub'); // must precede any src/ require
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { activate } = require('../src/extension');

let dir;
let file;

const openUri = (query) =>
  recorded.uriHandler.handleUri(
    vscode.Uri.parse(`vscodium://jpbochi.local-file-bridge/open?${query}`),
  );

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-file-bridge-'));
  // '+' would be turned into a space by URLSearchParams, so it belongs in a test.
  file = path.join(dir, 'c++ notes.md');
  await fsp.writeFile(file, 'alpha\nbravo\n');
  activate({ subscriptions: [], extension: { id: 'jpbochi.local-file-bridge' } });
});

after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

beforeEach(reset);

test('activation registers the scheme, the handler and both commands', () => {
  assert.deepEqual(recorded.schemes, ['local-file']);
  assert.deepEqual(recorded.commands, [
    'localFileBridge.openLocalPath',
    'localFileBridge.copyOpenUri',
  ]);
  assert.ok(recorded.uriHandler, 'a URI handler is registered');
});

test('a local window opens the path as a plain file: URI', async () => {
  await openUri(`path=${encodeURIComponent(file)}&line=42&column=7`);

  assert.equal(recorded.opened.length, 1);
  const { command, uri, options } = recorded.opened[0];
  assert.equal(command, 'vscode.open');
  assert.equal(uri.scheme, 'file');
  assert.equal(uri.path, file, 'the "+" in the path survived query parsing');
  assert.equal(options.selection.start.line, 41, 'line arrives 1-based');
  assert.equal(options.selection.start.character, 6, 'column arrives 1-based');
});

test('a remote window opens the same path through the local-file: scheme', async (t) => {
  vscode.env.remoteName = 'ssh-remote';
  t.after(() => {
    vscode.env.remoteName = undefined;
  });

  await openUri(`path=${encodeURIComponent(file)}`);

  const { uri, options } = recorded.opened[0];
  assert.equal(uri.scheme, 'local-file');
  assert.equal(uri.path, file, 'same path, only the scheme differs');
  assert.equal(options.selection, undefined, 'no line means no selection');
});

test('a leading ~ expands against the local home directory', async () => {
  await openUri('path=~/surely-no-such-file-here.md');

  assert.equal(recorded.opened.length, 0);
  assert.match(recorded.errors[0], /No such file on this machine/);
  assert.ok(
    recorded.errors[0].includes(os.homedir()),
    `expected the expanded home directory in: ${recorded.errors[0]}`,
  );
});

test('unusable URIs report an error and open nothing', async () => {
  await openUri('line=3'); // no path
  await openUri(`path=${encodeURIComponent(path.basename(file))}`); // relative
  await openUri(`path=${encodeURIComponent(dir)}`); // a directory
  await recorded.uriHandler.handleUri(
    vscode.Uri.parse('vscodium://jpbochi.local-file-bridge/nope?path=/tmp'),
  );

  assert.equal(recorded.opened.length, 0);
  assert.equal(recorded.errors.length, 4, 'each bad URI is surfaced to the user');
  assert.equal(recorded.logged.length, 4, 'and written to the output channel');
});
