// The `vscode` module is injected by the extension host and cannot be required
// outside it, so tests intercept the require and hand back this stand-in. Only
// the surface this extension actually touches is implemented.
const Module = require('node:module');

const recorded = {
  opened: [], // { command, uri, options } per executeCommand
  errors: [], // messages shown to the user
  logged: [], // messages written to the output channel
  schemes: [], // schemes registered as filesystem providers
  commands: [], // registered command ids
  uriHandler: undefined,
};

function reset() {
  recorded.opened.length = 0;
  recorded.errors.length = 0;
  recorded.logged.length = 0;
}

class Uri {
  constructor(scheme, authority, path, query) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
  }

  static file(path) {
    return new Uri('file', '', path, '');
  }

  // VS Code percent-decodes authority, path and query before handing a Uri to
  // an extension; reproducing that is the point of these tests.
  static parse(value) {
    const [, scheme, authority = '', path = '', query = ''] =
      /^([^:]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/.exec(value);
    return new Uri(scheme, decode(authority), decode(path), decode(query));
  }

  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
    );
  }

  get fsPath() {
    return this.path;
  }

  toString() {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

const decode = (value) => (value ? decodeURIComponent(value) : '');

class EventEmitter {
  #listeners = [];

  get event() {
    return (listener) => {
      this.#listeners.push(listener);
      return new Disposable(() => undefined);
    };
  }

  fire(event) {
    for (const listener of this.#listeners) listener(event);
  }

  dispose() {}
}

class Disposable {
  constructor(callback) {
    this.callback = callback;
  }

  dispose() {
    this.callback?.();
  }
}

const fileSystemError = (kind) => (uri) =>
  Object.assign(new Error(`${kind} (${uri})`), { kind });

const vscode = {
  Uri,
  EventEmitter,
  Disposable,
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  FileSystemError: {
    FileNotFound: fileSystemError('FileNotFound'),
    FileExists: fileSystemError('FileExists'),
    FileIsADirectory: fileSystemError('FileIsADirectory'),
    FileNotADirectory: fileSystemError('FileNotADirectory'),
    NoPermissions: fileSystemError('NoPermissions'),
    Unavailable: fileSystemError('Unavailable'),
  },
  env: {
    remoteName: undefined,
    uriScheme: 'vscodium',
    appName: 'VSCodium',
    clipboard: { writeText: async () => undefined },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      info: () => undefined,
      error: (message) => recorded.logged.push(message),
      dispose: () => undefined,
    }),
    registerUriHandler: (handler) => {
      recorded.uriHandler = handler;
      return new Disposable();
    },
    showErrorMessage: async (message) => recorded.errors.push(message),
    setStatusBarMessage: () => undefined,
    showInputBox: async () => undefined,
  },
  workspace: {
    registerFileSystemProvider: (scheme) => {
      recorded.schemes.push(scheme);
      return new Disposable();
    },
  },
  commands: {
    registerCommand: (id) => {
      recorded.commands.push(id);
      return new Disposable();
    },
    executeCommand: async (command, uri, options) => {
      recorded.opened.push({ command, uri, options });
    },
  },
};

const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === 'vscode' ? vscode : load(request, parent, isMain);

module.exports = { vscode, recorded, reset };
