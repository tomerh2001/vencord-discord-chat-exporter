# DiscordChatExporter for Vencord

Right-click a DM, group DM, server channel or thread and choose **Export chat**. A Discord dialog lets you configure the export, run the real [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) CLI, follow its output, cancel, and reveal the exported files.

This is a custom **desktop Vencord plugin** that manages DiscordChatExporter **2.48** itself. No separate exporter installation, path configuration or .NET installation is needed. On first use, it downloads the correct official self-contained executable, verifies its pinned SHA-256 checksum, and stores it in Vencord's data directory. Subsequent exports use the local copy.

The plugin still runs the actual exporter as a local child process; it is not a JavaScript rewrite or an embedded browser engine. It requires a custom Vencord build and does not work in browser Vencord. No companion web server is involved.

## Install

1. Set up a [Vencord source installation](https://docs.vencord.dev/installing/custom-plugins/). Use Node.js 22 or newer and the package manager version specified by that checkout.
2. Download and extract the plugin ZIP from the [latest release](https://github.com/tomerh2001/vencord-discord-chat-exporter/releases/latest). Open a terminal in the extracted folder, then copy the plugin into your Vencord checkout:

   ```sh
   node scripts/install-plugin.mjs --vencord /path/to/Vencord
   ```

   On Windows, quote paths containing spaces. The installer places the plugin in `src/userplugins/discordChatExporter.desktop`. It refuses to replace a pre-existing plugin it does not own. Alternatively, copy the contents of this repository's `plugin` directory into that directory yourself.
3. In the Vencord checkout, install dependencies, build and install your custom build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm inject
   ```

   Fully quit and restart Discord, then enable **DiscordChatExporter** in Vencord's plugin settings. Rebuild after plugin updates. Keep the plugin sources when updating Vencord.
4. Right-click a chat → **Export chat** → **Prepare exporter**. The plugin downloads about 9–12 MB from the [official 2.48 release](https://github.com/Tyrrrz/DiscordChatExporter/releases/tag/2.48), checks its integrity and capabilities, and prepares it locally. This step does not use your Discord token or access chat data. Failed or cancelled setup can be retried.
5. Choose an output file or directory, review the options, then press **Export**.

The pinned release covers Windows x64/ARM64/x86, macOS Intel/Apple Silicon, and Linux x64/ARM64/ARM. Linux musl has an x64 build. Other combinations report an unsupported-platform error instead of downloading the wrong binary. Vesktop can use a standalone custom Vencord build through its Vencord location setting; that installation path has not been tested here. Sandboxed desktop packages may restrict starting child processes or writing to your chosen destination.

## Export controls

- HTML dark/light, plain text, CSV and JSON.
- Output file, directory or filename template; message-count or file-size partitions.
- After/before boundaries, including message IDs; the full upstream message-filter language.
- Active or all accessible threads, including forum posts.
- Chronological or reverse order, Markdown processing, locale and UTC timestamps.
- Media downloads, reuse of downloaded media, and a separate media directory.
- Advisory rate limits and channel parallelism.
- Current Discord session authentication or an explicitly supplied user/bot token.
- Upstream console notice preference, export logs, cancellation and output-folder access.

See [the option parity reference](docs/option-parity.md) for exact upstream flags and exclusions. Deprecated `--bot` and `--dateformat` switches are omitted because upstream defines them as no-ops. Desktop-application preferences such as DCE's own theme and update checks are not export settings; this dialog follows Discord's theme.

For multiple thread exports, choose a directory or a filename template that gives each channel its own name. Forums need thread inclusion enabled. DCE 2.48 does not support media-channel containers; open an individual post and export its thread instead. Exported channels are those the supplied account can access; the plugin does not bypass permissions or recover deleted messages.

## Rate limits and credentials

The defaults match DCE's conservative settings: respect advisory rate limits, one channel at a time, no thread traversal and no media downloads. DCE also handles hard rate limits. The plugin allows only one active export job; increasing parallelism inside that job can still increase request volume. Downloading media and including archived threads can require many additional requests.

These settings do not make user-account automation ban-proof. [Upstream warns](https://github.com/Tyrrrz/DiscordChatExporter#readme) that Discord may ban automated user accounts and suggests using a bot where possible. Bots cannot export your personal DMs. The export dialog shows this warning and makes its rate-limit setting visible.

The current session token is read only when you press Export. A supplied token stays in dialog memory and is not saved. The native bridge passes the token through the child process's `DISCORD_TOKEN` environment variable, never through command arguments or an intermediate file. Logs are bounded and redact the supplied token. Before launching the exporter, the plugin rechecks the cached archive against its pinned release hash and verifies the extracted files. Export requests from the dialog cannot substitute an arbitrary executable. Processes running with sufficient permissions on your own computer can still inspect process memory or environments.

Export preferences are stored in Vencord settings; per-export date boundaries, filters and tokens are not remembered. A literal output filename must be chosen for each export; reusable folder paths and templates containing the channel ID can be remembered. Existing files may be replaced, including generated filenames when exporting the same channel again.

Export files and downloaded media contain the chat data you selected. Closing the dialog leaves an export running; reopening Export chat shows the current job. Disabling the plugin or closing/reloading its Discord window cancels the job. Windows terminates the child immediately; Unix first sends an interrupt, then forces it to stop after five seconds if needed. Cancellation may leave partial files.

## Development and verification

```sh
npm ci
npm test
```

Then install the plugin into a Vencord source checkout and run `pnpm testTsc` and `pnpm build --standalone` there. The automated tests use fake child processes and optional local CLI checks with no token; they do not log into Discord or export real messages. See [development notes](docs/development.md) for the tested upstream revision, architecture and manual verification steps.

## License

Plugin: GPL-3.0-or-later, matching Vencord. DiscordChatExporter is a separate MIT-licensed application by Oleksii Holub. Its official release is downloaded during first-use setup. Its notice is included in [plugin/DCE-LICENSE.txt](plugin/DCE-LICENSE.txt); see also [LICENSE](LICENSE) and the [upstream license](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/License.txt).
