const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vscode = require('vscode');

/**
 * Scheme used to expose the UI-side machine's disk. In a window connected to a
 * remote host, `file:` is served by the remote agent, so local paths are only
 * reachable through a scheme this extension provides from the local ext host.
 */
const LOCAL_SCHEME = 'local-file';

function toLocalUri(absolutePath) {
  return vscode.Uri.file(absolutePath).with({ scheme: LOCAL_SCHEME });
}

function toDiskPath(uri) {
  return uri.with({ scheme: 'file' }).fsPath;
}

class LocalFileSystemProvider {
  #emitter = new vscode.EventEmitter();

  onDidChangeFile = this.#emitter.event;

  dispose() {
    this.#emitter.dispose();
  }

  watch(uri, options) {
    const diskPath = toDiskPath(uri);
    let watcher;
    let watchingDirectory;
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
      this.#emitter.fire([{ type, uri: toLocalUri(changed) }]);
    });

    return new vscode.Disposable(() => watcher.close());
  }

  async stat(uri) {
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

  async readDirectory(uri) {
    const diskPath = toDiskPath(uri);
    try {
      const entries = await fsp.readdir(diskPath, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
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

  async createDirectory(uri) {
    try {
      await fsp.mkdir(toDiskPath(uri));
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
    this.#emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async readFile(uri) {
    try {
      return await fsp.readFile(toDiskPath(uri));
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  async writeFile(uri, content, options) {
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
    this.#emitter.fire([
      { type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  async delete(uri, options) {
    try {
      await fsp.rm(toDiskPath(uri), { recursive: options.recursive });
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
    this.#emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(source, target, options) {
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
    this.#emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: source },
      { type: vscode.FileChangeType.Created, uri: target },
    ]);
  }

  async copy(source, target, options) {
    const targetPath = toDiskPath(target);
    if (!options.overwrite && (await exists(targetPath))) {
      throw vscode.FileSystemError.FileExists(target);
    }
    try {
      await fsp.cp(toDiskPath(source), targetPath, { recursive: true, force: options.overwrite });
    } catch (error) {
      throw toFileSystemError(error, source);
    }
    this.#emitter.fire([{ type: vscode.FileChangeType.Created, uri: target }]);
  }
}

function fileType(entry) {
  if (entry.isDirectory()) {
    return vscode.FileType.Directory;
  }
  if (entry.isFile()) {
    return vscode.FileType.File;
  }
  return vscode.FileType.Unknown;
}

async function exists(diskPath) {
  try {
    await fsp.lstat(diskPath);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(diskPath) {
  try {
    await fsp.access(diskPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function toFileSystemError(error, uri) {
  const message = error instanceof Error ? error.message : String(error);
  switch (error?.code) {
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

module.exports = { LOCAL_SCHEME, LocalFileSystemProvider, toLocalUri, toDiskPath };
