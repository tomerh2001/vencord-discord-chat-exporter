# DiscordChatExporter option parity

The plugin targets **DiscordChatExporter CLI 2.48.x**. The flag names, choices, and defaults below were checked against the official 2.48.0 Linux executable's offline `export --help` output. The implementation was also reviewed against the [2.48 release source](https://github.com/Tyrrrz/DiscordChatExporter/tree/2.48) (commit `905489b01b5523719082275c34c232fc47f827c6`). No Discord credentials or API requests were used for these checks.

The integration invokes the official exporter to retain its export behavior, parsing, request scheduling, and retry handling. The plugin supplies options explicitly and never builds a shell command. This is an export dialog for the selected conversation or channel, including individual threads and forum posts; it does not add server-wide or account-wide bulk export commands.

## Dialog to CLI mapping

| Dialog option | CLI option | Plugin default | Behavior |
| --- | --- | --- | --- |
| Selected conversation / channel | `--channel` | Right-clicked channel ID | DMs, group DMs, server channels, and threads use the same export command. Forum parents require thread inclusion. |
| Discord account / supplied token | `DISCORD_TOKEN` environment variable | Current Discord session | Passed only to the child process; never included in arguments or saved preferences. Upstream infers user versus bot tokens. |
| Output file, folder, or template | `--output` | Must choose | Absolute path required. Folder paths end with a slash. Unlike upstream's working-directory default, the dialog requires an explicit destination. |
| Format | `--format` | `HtmlDark` | `HtmlDark`, `HtmlLight`, `PlainText`, `Csv`, and `Json`. |
| After | `--after` | Empty | Date with optional time/offset, or a Discord message ID. Upstream performs the final date parsing. |
| Before | `--before` | Empty | Date with optional time/offset, or a Discord message ID. Known inverted ranges are rejected locally. |
| Partition | `--partition` | Empty (one export file) | Positive message count or size such as `10mb` or `1.5gb`. Sizes use decimal B/KB/MB/GB, not KiB/MiB/GiB. |
| Include threads | `--include-threads` | `None` | `None`, `Active`, or `All` (active and archived). Thread exports require a folder or a filename template containing `%c` or `%C`. |
| Message filter | `--filter` | Empty | Full upstream filter expression, including authors, mentions, reactions, content types, boolean operators, quotes, and groups. |
| Parallel channel exports | `--parallel` | `1` | Relevant when included threads produce multiple exports. Separate plugin export jobs remain serial. |
| Newest messages first | `--reverse` | `false` | Reverses message chronology. |
| Format markdown and mentions | `--markdown` | `true` | Processes markdown, mentions, and other special tokens. |
| Download media | `--media` | `false` | Downloads assets referenced by the chosen export format, including attachments, avatars, and embedded images. |
| Reuse downloaded media | `--reuse-media` | `false` | Requires Download media. Reuses assets already present in the media destination. |
| Media folder | `--media-dir` | Empty | Requires Download media. Empty derives the media folder from the export output path. |
| Locale | `--locale` | Empty (system locale) | Controls date and number formatting. The current CLI help takes precedence over older prose documentation that says `en-US`. |
| Normalize timestamps to UTC | `--utc` | `false` | Uses UTC+0 for exported timestamps. |
| Respect advisory rate limits | `--respect-rate-limits` | **`true`** | Preserves upstream's rate-limit handling. Turning this off ignores advisory limits but still obeys hard HTTP 429 responses. |
| Hide Support Ukraine console message | `--fuck-russia` | `false` | Controls only the upstream console callout. No effect on exported messages. |

The export-option source is [ExportCommandBase.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/DiscordChatExporter.Cli/Commands/Base/ExportCommandBase.cs), and token/rate-limit options are in [DiscordCommandBase.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/DiscordChatExporter.Cli/Commands/Base/DiscordCommandBase.cs). See also the upstream [CLI guide](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/.docs/Using-the-CLI.md) and [message filter guide](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/.docs/Message-filters.md).

## Request volume and rate limits

The defaults match the official CLI: respect advisory limits, export one channel at a time, exclude child threads, and do not download media. Respecting rate limits does not guarantee that using an account token is risk-free. The plugin does not replace DCE's HTTP client, bypass HTTP 429 handling, or claim to make unofficial Discord account automation safe.

Date or message-ID bounds constrain fetched history. A message filter is applied **after messages are fetched** and should not be treated as a way to reduce API requests. Partitioning splits output files; it does not cap the total history fetched. Including archived threads, downloading media, or increasing parallel exports can increase request volume. Reusing media can avoid redundant downloads when media is enabled. These behaviors are visible in [ChannelExporter.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/DiscordChatExporter.Core/Exporting/ChannelExporter.cs) and [DiscordClient.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/DiscordChatExporter.Core/Discord/DiscordClient.cs).

Upstream GUI settings offer four rate-limit preferences: Always respect, Always ignore, Respect for user tokens, and Respect for bot tokens. The official CLI exposes only `--respect-rate-limits true` or `--respect-rate-limits false`; the dialog presents that exact control. For a given user or bot token the GUI's token-specific modes resolve to one of those same two behaviors, but the plugin does not infer a supplied token's kind to reproduce the four GUI labels. See [RateLimitPreference.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/DiscordChatExporter.Core/Discord/RateLimitPreference.cs).

## Intentional exclusions and validation

- `--dateformat` and `--bot` are documented no-ops in 2.48; no compatibility controls are exposed for them. Token kind is inferred by DCE.
- `--include-vc` and `--include-dm` belong to broader guild/account export commands, not a selected-channel export.
- GUI appearance, app updates, interface language, and saved-token encryption settings belong to the standalone DCE application. They do not affect the selected-channel export and are not reproduced.
- DCE 2.48 has no export proxy flag. The plugin does not invent a proxy or request-delay option.
- The plugin requires an explicit absolute destination, validates positive partition/concurrency values and media dependencies, and requires a folder or a template containing channel ID/name when including threads. This is stricter than upstream accepting any percent sign; a server/category-only template can overwrite the previous thread's file. Upstream remains responsible for its complete date, locale, and message-filter grammar.
- Template tokens include `%g/%G` (server ID/name), `%t/%T` (category ID/name), `%c/%C` (channel ID/name), `%p/%P` (channel/category position), `%a/%b` (after/before), `%d` (current date), and `%%` (literal percent). When exporting threads, use `%c` in filenames to avoid collisions between identically named channels.
- DCE 2.48 requires separate option and value arguments; it rejects `--flag=value`. The plugin passes each value as one argument without a shell, wraps the complete filter in parentheses to preserve leading negation, and rejects option-like date/locale values. Do not add shell escaping or quotes around the whole value in the dialog.

The plugin downloads the pinned 2.48 engine itself; it does not accept an arbitrary executable or silently update it. Updating support to a new DCE release requires checking its actual `export --help`, reviewing option/HTTP behavior changes, updating the release manifest with independently verified official archive sizes and digests, updating the native compatibility check, and rerunning the offline tests. Also run a real export argument parse with no token and without `--help`: its only error must be the missing token. A help invocation skips normal parsing and cannot validate argument syntax. Do not silently accept a release with an unknown option contract.
