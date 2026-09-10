/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Export arguments are based on DiscordChatExporter 2.48. */
export type ExportFormat = "HtmlDark" | "HtmlLight" | "PlainText" | "Csv" | "Json";
export type ThreadInclusion = "None" | "Active" | "All";

/** Credentials deliberately do not belong in export preferences or command arguments. */
export interface ExportOptions {
    outputPath: string;
    format: ExportFormat;
    after: string;
    before: string;
    partition: string;
    includeThreads: ThreadInclusion;
    filter: string;
    parallel: number;
    reverse: boolean;
    markdown: boolean;
    media: boolean;
    reuseMedia: boolean;
    mediaDir: string;
    locale: string;
    utc: boolean;
    respectRateLimits: boolean;
    suppressUkraineMessage: boolean;
}

export const FORMAT_OPTIONS = [
    { label: "HTML (Dark)", value: "HtmlDark", extension: "html" },
    { label: "HTML (Light)", value: "HtmlLight", extension: "html" },
    { label: "Plain text", value: "PlainText", extension: "txt" },
    { label: "CSV", value: "Csv", extension: "csv" },
    { label: "JSON", value: "Json", extension: "json" }
] as const;

export const THREAD_OPTIONS = [
    { label: "Do not include threads", value: "None" },
    { label: "Active threads", value: "Active" },
    { label: "Active and archived threads", value: "All" }
] as const;

export const DEFAULT_OPTIONS: Readonly<ExportOptions> = Object.freeze({
    outputPath: "",
    format: "HtmlDark",
    after: "",
    before: "",
    partition: "",
    includeThreads: "None",
    filter: "",
    parallel: 1,
    reverse: false,
    markdown: true,
    media: false,
    reuseMedia: false,
    mediaDir: "",
    locale: "",
    utc: false,
    respectRateLimits: true,
    suppressUkraineMessage: false
});

export function createDefaultOptions(): ExportOptions {
    return { ...DEFAULT_OPTIONS };
}

const STRING_FIELDS = ["outputPath", "after", "before", "partition", "filter", "mediaDir", "locale"] as const;
const BOOLEAN_FIELDS = ["reverse", "markdown", "media", "reuseMedia", "utc", "respectRateLimits", "suppressUkraineMessage"] as const;
const MAX_SNOWFLAKE = 18446744073709551615n;
const DISCORD_EPOCH = 1420070400000n;

function isAbsolutePath(value: string): boolean {
    // Cross-platform validation works in the renderer; the native side also checks its own OS.
    return /^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value);
}

/** Recognize numeric IDs and common ISO dates without replacing upstream's date parser. */
function comparableBoundary(value: string): bigint | undefined {
    if (/^\d+$/.test(value)) {
        const id = BigInt(value);
        return id <= MAX_SNOWFLAKE ? id : undefined;
    }
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value)) return;
    // .NET treats a date without an offset as local time, including date-only input.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
    const milliseconds = Date.parse(normalized);
    if (!Number.isFinite(milliseconds) || BigInt(milliseconds) < DISCORD_EPOCH) return;
    const id = (BigInt(milliseconds) - DISCORD_EPOCH) << 22n;
    return id <= MAX_SNOWFLAKE ? id : undefined;
}

function isValidPartition(value: string): boolean {
    if (/^\d+$/.test(value)) {
        const count = BigInt(value);
        return count > 0n && count <= 2147483647n;
    }
    const match = /^(\d+(?:\.\d*)?)\s*([kmg]?)b$/i.exec(value);
    if (!match) return false;
    const magnitude = { "": 1, k: 1e3, m: 1e6, g: 1e9 }[match[2].toLowerCase()]!;
    const bytes = Number(match[1]) * magnitude;
    return Number.isFinite(bytes) && bytes >= 1 && bytes < 9223372036854775808;
}

/** Validate again in the native process: IPC callers are not a trusted type boundary. */
export function validateExportOptions(options: ExportOptions): string[] {
    const errors: string[] = [];
    if (!options || typeof options !== "object") return ["Export options are missing."];

    for (const key of STRING_FIELDS) {
        if (typeof options[key] !== "string") errors.push(`${key} must be text.`);
        else if (options[key].includes("\0")) errors.push(`${key} cannot contain a null character.`);
    }
    for (const key of BOOLEAN_FIELDS) {
        if (typeof options[key] !== "boolean") errors.push(`${key} must be true or false.`);
    }
    if (!FORMAT_OPTIONS.some(option => option.value === options.format)) errors.push("Choose a supported export format.");
    if (!THREAD_OPTIONS.some(option => option.value === options.includeThreads)) errors.push("Choose which threads to include.");
    if (!Number.isInteger(options.parallel) || options.parallel < 1 || options.parallel > 2147483647) {
        errors.push("Parallel exports must be a whole number between 1 and 2147483647.");
    }
    // Avoid dereferencing malformed IPC values in the semantic checks below.
    if (errors.length) return errors;

    const outputPath = options.outputPath.trim();
    if (!outputPath) errors.push("Choose an output file or folder.");
    else if (!isAbsolutePath(outputPath)) errors.push("Use an absolute output path, or select a file or folder with Browse.");
    else if (options.includeThreads !== "None" && !/[\\/]$/.test(outputPath) && !/%[cC]/.test(outputPath.replace(/%%/g, ""))) {
        errors.push("When including threads, use a folder path ending in a slash or an output path template containing %c or %C (for example %C-%c.html).");
    }

    if (options.partition.trim() && !isValidPartition(options.partition.trim())) {
        errors.push("Partition must be a positive message count (for example 10000) or size in B, KB, MB, or GB (for example 10mb).");
    }
    if (options.reuseMedia && !options.media) errors.push("Enable Download media before reusing downloaded media.");
    if (options.mediaDir.trim() && !options.media) errors.push("Enable Download media before choosing a media folder.");
    if (options.mediaDir.trim() && !isAbsolutePath(options.mediaDir.trim())) errors.push("Use an absolute media folder path.");

    for (const key of ["after", "before", "locale"] as const) {
        if (options[key].trim().startsWith("-")) errors.push(`${key} cannot begin with a dash or command-line option.`);
    }

    for (const key of ["after", "before"] as const) {
        const value = options[key].trim();
        if (/^\d+$/.test(value) && BigInt(value) > MAX_SNOWFLAKE) errors.push(`${key} contains a message ID larger than Discord supports.`);
        // Richer date syntax and message filter expressions are parsed by DCE before it exports.
    }
    const after = comparableBoundary(options.after.trim());
    const before = comparableBoundary(options.before.trim());
    if (after !== undefined && before !== undefined && after >= before) errors.push("After must be earlier than Before.");
    return errors;
}

/** Build an argv array, never a shell command. DCE 2.48 requires separate option/value entries. */
export function buildExportArgs(channelId: string, options: ExportOptions): string[] {
    if (typeof channelId !== "string" || !/^\d{1,20}$/.test(channelId) || BigInt(channelId) === 0n || BigInt(channelId) > MAX_SNOWFLAKE) {
        throw new Error("A valid Discord channel ID is required.");
    }
    const errors = validateExportOptions(options);
    if (errors.length) throw new Error(errors.join("\n"));

    const args = [
        "export",
        "--channel", channelId,
        "--output", options.outputPath.trim(),
        "--format", options.format,
        "--include-threads", options.includeThreads,
        "--parallel", String(options.parallel),
        "--reverse", String(options.reverse),
        "--markdown", String(options.markdown),
        "--media", String(options.media),
        "--reuse-media", String(options.reuseMedia),
        "--utc", String(options.utc),
        "--respect-rate-limits", String(options.respectRateLimits),
        "--fuck-russia", String(options.suppressUkraineMessage)
    ];
    for (const [flag, value] of [
        ["after", options.after],
        ["before", options.before],
        ["partition", options.partition],
        ["filter", options.filter],
        ["media-dir", options.mediaDir],
        ["locale", options.locale]
    ]) {
        // Group the entire filter so leading negations cannot be mistaken for CLI switches.
        if (value.trim()) args.push(`--${flag}`, flag === "filter" ? `(${value.trim()})` : value.trim());
    }
    return args;
}
