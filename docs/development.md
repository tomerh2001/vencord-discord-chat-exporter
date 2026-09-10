# Development notes

## Upstream versions

- Vencord: `0850f37fbb1623aa6330764d8f4b1e0b2617dcdf` (package version 1.15.5).
- DiscordChatExporter: official release 2.48, CLI reports `v2.48.0`.
- Linux x64 release ZIP SHA-256: `3e253e28ec7ea034b2201443fa84571142945299296541ecbe196ffceef8bc3c` (verified against GitHub release asset metadata).

## Verification result (2026-09-10)

All 52 automated tests passed, including the optional real CLI version/capability and argument-parsing checks. Full Vencord TypeScript checking, repository ESLint, CSS Stylelint, the standalone desktop build and plugin-list generation passed against the revision above. The renderer and native bundles both contain the plugin. The Vencord review branch includes the same tests under `scripts/discordChatExporterTests/`. No live Discord session or chat export was exercised; the native dialog still needs a live client smoke test.

The managed installer also passed a real Linux x64 release smoke test: download, pinned hash verification, extraction, capability checks, then cached startup and executable verification with network access disabled in the test. Runtime execution on Windows, macOS and other Linux architectures has not been tested here.

To include the real offline CLI checks, set `DCE_EXECUTABLE` to the absolute path of the official 2.48 executable before running `npm test`. They check `--version`, `export --help`, and complete export argument sets that intentionally omit the required token. Each child has the Discord token removed from its environment; parsing stops before authentication. Without that variable, these two tests are skipped.

## Structure

`plugin/index.tsx` registers context-menu actions. `channels.ts` resolves channel IDs without creating or opening a DM. In a user menu, a server channel is rejected so exporting a member's chat cannot accidentally export the whole channel. Categories are excluded.

`ExportModal.tsx` uses Discord's native components; `options.ts` defines validated export settings and constructs a fixed command argument list. `bridge.ts` connects to Vencord's native plugin helpers. `native.ts` owns Electron file pickers, setup checks and sender lifecycle. `runner.ts` starts the actual CLI and owns the single active job, redaction, process termination and status snapshots.

`engine.ts` manages first-use downloads and the persistent cache under `DATA_DIR/DiscordChatExporter/2.48/<runtime>/`. `engineRelease.ts` pins each official archive's filename, byte size and SHA-256 digest. The manager authenticates archives before extraction, restricts ZIP entry types/paths/sizes, stages installation before publishing the cache, and rechecks extracted file hashes before returning an executable. The renderer cannot supply an executable path.

Setup probes use a separate runner from exports. Explicit setup cancellation must not stop an active export; closing/reloading the owning window or disabling the plugin cancels both. Cached engine checks share a promise, so cancellation must invalidate its owner/generation and guard promise cleanup by identity. Repair must not replace files while an export is starting or running.

No HTTP listener or Discord fetching code is added. DCE retains responsibility for token inference, permission checks, message traversal, request retries, rate limits, filtering, partitioning, formatting and downloads.

## Vencord integration details

Current Vencord exports the native `Modal` component and `RenderModalProps` from `@webpack/common`; its legacy `ModalRoot` and related components are typed as `never`. Use the current API when extending this dialog.

The current Discord `Select` declaration incorrectly types ARIA labels as booleans. The dialog locally corrects this to string attributes, without altering upstream types. Recheck that cast after updating Vencord's Discord types.

Native helpers must export functions whose first parameter is the Electron IPC event. `PluginNative<typeof import("./native")>` removes that event parameter on the renderer side. Keep classes, constants and non-IPC exports in a separate file, because Vencord treats native exports as callable helpers.

The `.desktop` suffix on the installed plugin directory excludes it from web builds. The plugin name must remain the literal `DiscordChatExporter` in `definePlugin`, matching `VencordNative.pluginHelpers.DiscordChatExporter`.

The standalone custom plugin uses inline author metadata. Vencord's official plugin-list generator accepts only `Devs.<name>` references, so the prepared repository branch uses `Devs.tomerh2001` with a matching constants entry. Vencord explicitly supports `0n` for authors who do not supply a Discord profile ID. This avoids inventing an identity and leaves the custom plugin install independent of core-file edits.

The CLI exposes a boolean advisory-limit control; it does not expose the GUI's token-dependent preference enum or a custom delay control. Do not invent flags for those settings. Do not replace the real exporter with an independent message downloader when adding options.

DCE 2.48's CliFx parser requires separate argument values (`--format`, `Json`), and rejects `--format=Json`. A `--help` invocation bypasses argument validation, so it cannot prove a constructed export command is valid. The real CLI regression check omits both `--help` and the required token, then requires the specific missing-token error with no unrecognized options. This exercises parsing without authenticating or making Discord requests.

A filter beginning with `-has:link` can be interpreted as the `-h` help switch. The argument builder groups filter expressions in parentheses so negation remains part of the filter grammar. Do not use shell quoting to solve this: the process receives an argument array and no shell is involved.

## Manual verification in Discord

1. Right-click a DM, group DM, server text/announcement channel and a thread. Confirm Export chat opens the correct name and channel ID. A server member context menu and a category must not export the surrounding channel.
2. Press Prepare exporter. Confirm download progress, hash verification and offline version/help checks complete without a token or Discord requests. Cancel and retry preparation. Reopen the dialog after setup and confirm the cache works without downloading again.
3. Choose a new output directory, use a small after/before range, and export a chat you intend to export. Inspect the resulting file and native log. Exercise each output format with that limited range.
4. Confirm media reuse and media directory controls require downloads. Confirm forum exports require threads and multi-channel exports require suitable output names.
5. Close and reopen the dialog while exporting, then cancel. Confirm there is only one exporter process and no further requests after cancellation completes. Partial files may remain.
6. Verify bad credentials and an inaccessible channel surface exporter errors without exposing the token. Verify an export with partial channel failures shows warnings rather than an unqualified success.
7. Restart Discord and confirm the managed engine and preferences remain while authentication overrides, filters and date ranges do not.

On this development host, `/tmp` is mounted with execution disabled. Executable-permission checks can fail there even after `chmod`. Engine tests therefore create and remove temporary directories under the repository's ignored `.cache` directory.

## Upstream submission

Vencord's [contribution rules](https://github.com/Vendicated/Vencord/blob/main/CONTRIBUTING.md) require majority human-written contributions and prohibit AI-written PR descriptions/communications, with a permanent-block warning. Its [PR template](https://github.com/Vendicated/Vencord/blob/main/.github/pull_request_template.md) also requires a human-authorship declaration. This plugin was authored with a coding assistant and does not meet those submission requirements; reviewing generated code alone does not change its authorship. No upstream PR or compliance declaration should be inferred from the prepared local branch.

Live Discord checks are deliberately separate from offline automated verification. A successful build and unit tests establish integration and process behavior, but do not establish that Discord's current deployed context menus and components render correctly on a user's client.
