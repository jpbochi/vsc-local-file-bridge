import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Scheme used to expose the UI-side machine's disk. In a window connected to a
 * remote host, `file:` is served by the remote agent, so local paths are only
 * reachable through a scheme this extension provides from the local ext host.
 */
export const LOCAL_SCHEME = 'local-file';

export function toLocalUri(absolutePath: string): vscode.Uri {
  return vscode.Uri.file(absolutePath).with({ scheme: LOCAL_SCHEME });
}

export function toDiskPath(uri: vscode.Uri): string {
  return uri.with({ scheme: 'file' }).fsPath;
}

export class LocalFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
  }

  watch(uri: vscode.Uri, options: { readonly recursive: boolean }): vscode.Disposable {
    const diskPath = toDiskPath(uri);
    let watcher: fs.FSWatcher;
    let watchingDirectory: boolean;
    try {
      watchingDirectory = fs.statSync(diskPath).isDirectory();
      watcher = fs.watch(diskPath, { recursive: options.recursive && watchingDirectory });
    } catch {
      return new vscode.Disposable(() => undefined);
    }

    watcher.on('error', () => watcher.close());
    watcher.on('change', (event, filename) => {
      const changed =
        watchingDirectory && filename ? path.join(diskPath, filename.toString()) : diskPath;
      const type =
        event === 'rename'
          ? fs.existsSync(changed)
            ? vscode.FileChangeType.Created
            : vscode.FileChangeType.Deleted
          : vscode.FileChangeType.Changed;
      this.emitter.fire([{ type, uri: toLocalUri(changed) }]);
    });

    return new vscode.Disposable(() => watcher.close());
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const diskPath = toDiskPath(uri);
    try {
      const link = await fsp.lstat(diskPath);
      const permissions = (await isWritable(diskPath))
        ? undefined
        : vscode.FilePermission.Readonly;
      if (!link.isSymbolicLink()) {
        return {
          type: fileType(link),
          ctime: link.ctimeMs,
          mtime: link.mtimeMs,
          size: link.size,
          permissions,
        };
      }
      try {
        // Report the target's size and times; the link's own are meaningless
        // to the editor.
        const target = await fsp.stat(diskPath);
        return {
          type: vscode.FileType.SymbolicLink | fileType(target),
          ctime: target.ctimeMs,
          mtime: target.mtimeMs,
          size: target.size,
          permissions,
        };
      } catch {
        return {
          type: vscode.FileType.SymbolicLink,
          ctime: link.ctimeMs,
          mtime: link.mtimeMs,
          size: 0,
        };
      }
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const diskPath = toDiskPath(uri);
    try {
      const entries = await fsp.readdir(diskPath, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry): Promise<[string, vscode.FileType]> => {
          if (!entry.isSymbolicLink()) {
            return [entry.name, fileType(entry)];
          }
          try {
            const target = await fsp.stat(path.join(diskPath, entry.name));
            return [entry.name, vscode.FileType.SymbolicLink | fileType(target)];
          } catch {
            return [entry.name, vscode.FileType.SymbolicLink];
          }
        }),
      );
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      await fsp.mkdir(toDiskPath(uri));
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return await fsp.readFile(toDiskPath(uri));
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const diskPath = toDiskPath(uri);
    const existed = await exists(diskPath);
    if (!existed && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (existed && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!existed && !(await exists(path.dirname(diskPath)))) {
      throw vscode.FileSystemError.FileNotFound(uri.with({ path: path.dirname(uri.path) }));
    }
    try {
      await fsp.writeFile(diskPath, content);
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
    this.emitter.fire([
      { type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    try {
      await fsp.rm(toDiskPath(uri), { recursive: options.recursive });
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    source: vscode.Uri,
    target: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    const targetPath = toDiskPath(target);
    if (await exists(targetPath)) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(target);
      }
      // fs.rename refuses to replace a non-empty directory.
      await fsp.rm(targetPath, { recursive: true, force: true });
    }
    try {
      await fsp.rename(toDiskPath(source), targetPath);
    } catch (error) {
      throw toFileSystemError(error, source);
    }
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: source },
      { type: vscode.FileChangeType.Created, uri: target },
    ]);
  }

  async copy(
    source: vscode.Uri,
    target: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    const targetPath = toDiskPath(target);
    if (!options.overwrite && (await exists(targetPath))) {
      throw vscode.FileSystemError.FileExists(target);
    }
    try {
      await fsp.cp(toDiskPath(source), targetPath, { recursive: true, force: options.overwrite });
    } catch (error) {
      throw toFileSystemError(error, source);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri: target }]);
  }
}

function fileType(entry: fs.Stats | fs.Dirent): vscode.FileType {
  if (entry.isDirectory()) {
    return vscode.FileType.Directory;
  }
  if (entry.isFile()) {
    return vscode.FileType.File;
  }
  return vscode.FileType.Unknown;
}

async function exists(diskPath: string): Promise<boolean> {
  try {
    await fsp.lstat(diskPath);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(diskPath: string): Promise<boolean> {
  try {
    await fsp.access(diskPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function toFileSystemError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ENOENT':
      return vscode.FileSystemError.FileNotFound(uri);
    case 'EISDIR':
    case 'ERR_FS_EISDIR':
      return vscode.FileSystemError.FileIsADirectory(uri);
    case 'ENOTDIR':
      return vscode.FileSystemError.FileNotADirectory(uri);
    case 'EEXIST':
      return vscode.FileSystemError.FileExists(uri);
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return vscode.FileSystemError.NoPermissions(uri);
    default:
      return vscode.FileSystemError.Unavailable(message);
  }
}
