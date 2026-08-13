import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LOCAL_SCHEME, LocalFileSystemProvider, toDiskPath, toLocalUri } from './localFileSystem';

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Reuse Remote Window', { log: true });
  const provider = new LocalFileSystemProvider();

  context.subscriptions.push(
    log,
    provider,
    vscode.workspace.registerFileSystemProvider(LOCAL_SCHEME, provider, {
      isCaseSensitive: process.platform === 'linux',
    }),
    vscode.window.registerUriHandler({ handleUri }),
    vscode.commands.registerCommand('reuseRemoteWindow.openLocalPath', promptAndOpen),
    vscode.commands.registerCommand('reuseRemoteWindow.copyOpenUri', () =>
      copyOpenUri(context.extension.id),
    ),
  );

  log.info(
    `Activated. remoteName=${vscode.env.remoteName ?? '<none>'} uriScheme=${vscode.env.uriScheme} extension=${context.extension.id}`,
  );
}

async function handleUri(uri: vscode.Uri): Promise<void> {
  log.info(`Handling URI: ${uri.toString(true)}`);
  const route = uri.path.replace(/\/+$/, '');
  if (route !== '/open') {
    fail(`Unsupported URI path "${uri.path}". Expected "/open".`);
    return;
  }

  const query = parseQuery(uri.query);
  const rawPath = query.get('path');
  if (!rawPath) {
    fail('The URI is missing a "path" query parameter.');
    return;
  }

  await openLocalPath(rawPath, toPosition(query.get('line'), query.get('column')));
}

async function openLocalPath(rawPath: string, selection?: vscode.Range): Promise<void> {
  let diskPath: string;
  try {
    diskPath = resolveLocalPath(rawPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    if ((await fsp.stat(diskPath)).isDirectory()) {
      fail(`"${diskPath}" is a directory. This extension opens files only.`);
      return;
    }
  } catch {
    fail(`No such file on this machine: "${diskPath}".`);
    return;
  }

  // In a remote window, `file:` resolves against the remote host's disk, so the
  // local path has to be served through this extension's own scheme instead.
  const remote = vscode.env.remoteName;
  const target = remote === undefined ? vscode.Uri.file(diskPath) : toLocalUri(diskPath);

  log.info(`Opening ${target.toString(true)}`);
  await vscode.commands.executeCommand('vscode.open', target, { preview: false, selection });

  if (remote !== undefined) {
    vscode.window.setStatusBarMessage(
      `$(vm-connect) Opened local file ${path.basename(diskPath)} in this ${remote} window`,
      5000,
    );
  }
}

async function promptAndOpen(): Promise<void> {
  const rawPath = await vscode.window.showInputBox({
    title: 'Open Local File in This Window',
    prompt: `Absolute path on the machine running the ${vscode.env.appName} UI`,
    placeHolder: path.join(os.homedir(), 'notes.md'),
    ignoreFocusOut: true,
  });
  if (rawPath) {
    await openLocalPath(rawPath);
  }
}

async function copyOpenUri(extensionId: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!document || (document.uri.scheme !== 'file' && document.uri.scheme !== LOCAL_SCHEME)) {
    fail('Open a local file first — there is no local path to build a URI from.');
    return;
  }
  if (document.uri.scheme === 'file' && vscode.env.remoteName !== undefined) {
    fail('The active file lives on the remote host, so it has no local path.');
    return;
  }

  const diskPath = toDiskPath(document.uri);
  const line = editor.selection.active.line + 1;
  const uri = `${vscode.env.uriScheme}://${extensionId}/open?path=${encodeURIComponent(diskPath)}&line=${line}`;
  await vscode.env.clipboard.writeText(uri);
  vscode.window.setStatusBarMessage(`$(clippy) Copied ${uri}`, 5000);
}

/**
 * VS Code percent-decodes the query before handing the URI to an extension, so
 * decoding again (as URLSearchParams would) corrupts paths containing "+" or
 * "%". Segments without "=" are stitched back on, which recovers paths that
 * contain a literal "&".
 */
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  let lastKey: string | undefined;
  for (const segment of query.split('&')) {
    const separator = segment.indexOf('=');
    if (separator === -1) {
      if (lastKey !== undefined) {
        params.set(lastKey, `${params.get(lastKey)}&${segment}`);
      }
      continue;
    }
    lastKey = segment.slice(0, separator);
    params.set(lastKey, segment.slice(separator + 1));
  }
  return params;
}

function resolveLocalPath(rawPath: string): string {
  let value = rawPath.trim();
  if (/^file:\/\//i.test(value)) {
    value = vscode.Uri.parse(value).fsPath;
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`"${rawPath}" is not an absolute path.`);
  }
  return path.normalize(value);
}

function toPosition(line: string | undefined, column: string | undefined): vscode.Range | undefined {
  if (line === undefined) {
    return undefined;
  }
  const at = new vscode.Position(
    Math.max(0, (Number.parseInt(line, 10) || 1) - 1),
    Math.max(0, (Number.parseInt(column ?? '1', 10) || 1) - 1),
  );
  return new vscode.Range(at, at);
}

function fail(message: string): void {
  log.error(message);
  void vscode.window.showErrorMessage(`Reuse Remote Window: ${message}`);
}
