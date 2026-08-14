# Local File Bridge

Open a file from your **local** disk in whatever VSCodium/VS Code window handles the URI —
including a window that is connected to a remote host over SSH, WSL, or a dev container.

Here are example links to open `~/.gitconfig` (in VSCode, VSCodium, and Cursor):

- Copy and paste these (GitHub doesn't allow unusual URI schemes in markdown):
  - [`vscode://jpbochi.local-file-bridge/open?path=~/.gitconfig`](vscode://jpbochi.local-file-bridge/open?path=~/.gitconfig)
  - [`vscodium://jpbochi.local-file-bridge/open?path=~/.gitconfig&line=42&column=7`](vscodium://jpbochi.local-file-bridge/open?path=~/.gitconfig&line=42&column=7)
  - [`cursor://jpbochi.local-file-bridge/open?path=~/.gitconfig&line=42&column=7`](cursor://jpbochi.local-file-bridge/open?path=~/.gitconfig&line=42&column=7)
- Or use these indirect links (vscode.dev allows `vscode:`, my own tiny page allows others like `vscodium:` and `cursor:`):
  - https://vscode.dev/redirect?url=vscode%3A%2F%2Fjpbochi.local-file-bridge%2Fopen%3Fpath%3D~%2F.gitconfig
  - https://jpbochi.github.io/open?u=vscodium%3A%2F%2Fjpbochi.local-file-bridge%2Fopen%3Fpath%3D~%2F.gitconfig
  - https://jpbochi.github.io/open?u=cursor%3A%2F%2Fjpbochi.local-file-bridge%2Fopen%3Fpath%3D~%2F.gitconfig

## Why it needs a custom scheme

Inside a remote window, the `file:` scheme is served by the remote agent, so `file:///Users/jp/.gitconfig`
means *that path on the remote host* — usually nothing. There is no built-in way to address the
local machine from a remote window (`vscode-remote:` only works in the other direction).

So this extension declares `"extensionKind": ["ui"]`, which pins it to the local extension host even in remote
windows, and registers a `FileSystemProvider` for `local-file:`, backed by Node's `fs` on that local machine.

- In a **local** window the file opens as a normal `file:` URI.
- In a **remote** window it opens as `local-file:/Users/jp/.gitconfig` — `~` is expanded and the path is carried
  over untouched — read and written straight through to local disk. Editing and saving work; features that
  assume `file:` (Git decorations, remote-side language servers) do not.

The extension is installed only on your local machine — nothing to install on the remote hosts.

## Which window gets the file?

The editor routes the URI to one window, normally the most recently focused one that has the extension enabled,
and opens a new window if none is running. This extension takes whichever window it lands in;
it cannot pick a different one.

## URI reference

`{{scheme}}://jpbochi.local-file-bridge/open?path=...`

| Parameter | Required | Notes                                          |
| --------- | -------- | ---------------------------------------------- |
| `path`    | yes      | Absolute local path, `~/…`, or a `file://` URI |
| `line`    | no       | 1-based line to reveal                         |
| `column`  | no       | 1-based column, defaults to 1                  |

Use `vscode://` instead of `vscodium://` in VS Code, `cursor://` in Cursor, etc.

Percent-encode `path` whenever it may contain characters that are reserved in a URI, for example with
`python3 -c 'import sys,urllib.parse as u; print(u.quote(sys.argv[1], safe=""))' "$path"`.

## Commands

- **Local File Bridge: Open Local File in This Window** — prompts for a path; useful for testing without a URI.
- **Local File Bridge: Copy vscodium:// URI for a Local File** — builds the URI for the active editor,
  with its current line.

Logs are in the **Local File Bridge** output channel.

## Build and install

Plain CommonJS under `src/`, no build step — `npm install` is only there to fetch `vsce` for packaging,
and the extension itself has no dependencies.

`npm test` runs Node's built-in test runner against `src/`, with `test/vscode-stub.js` standing in for
the `vscode` module, which only exists inside an extension host.

```sh
npm install
npm run package                       # produces local-file-bridge-0.0.1.vsix
codium --install-extension local-file-bridge-0.0.1.vsix
```

Reload existing windows afterwards (**Developer: Reload Window**) so they pick up the extension — a window's
extension host is bound to the set of extension identities it started with, so a renamed or newly installed
extension is invisible to windows that were already open. If a window reports that something else already owns
the `local-file:` scheme, reloading it releases the stale provider; only one extension per window can own a scheme.

To hack on it, press <kbd>F5</kbd> (Run Extension) and fire a URI at the Extension Development Host window.
