import assert from "node:assert/strict";
import test from "node:test";

import { buildExportArgs, createDefaultOptions, ExportOptions, validateExportOptions } from "../plugin/options.ts";

const CHANNEL_ID = "123456789012345678";
const options = (changes: Partial<ExportOptions> = {}): ExportOptions => ({
    ...createDefaultOptions(), outputPath: "/tmp/discord-exports/chat.html", ...changes
});
const argumentValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("default export is serial and respects advisory rate limits with no media or threads", () => {
    const args = buildExportArgs(CHANNEL_ID, options());
    for (const [flag, value] of [["--respect-rate-limits", "true"], ["--parallel", "1"], ["--include-threads", "None"], ["--media", "false"], ["--reuse-media", "false"]])
        assert.equal(argumentValue(args, flag), value, flag);
    assert.deepEqual(validateExportOptions(options()), []);
    assert.notEqual(createDefaultOptions(), createDefaultOptions());
});

test("every supported meaningful export option is mapped without credentials or no-op switches", () => {
    const args = buildExportArgs(CHANNEL_ID, options({
        outputPath: "C:\\Discord Exports\\%C-%c.json",
        format: "Json", after: "2025-01-01", before: "2026-01-01", partition: "1.5mb",
        includeThreads: "All", filter: "(from:alice | from:bob) has:image", parallel: 2,
        reverse: true, markdown: false, media: true, reuseMedia: true,
        mediaDir: "C:\\Discord Media", locale: "he-IL", utc: true,
        respectRateLimits: false, suppressUkraineMessage: true
    }));
    assert.equal(args[0], "export");
    assert.deepEqual(args.slice(1).filter((_arg, index) => index % 2 === 0).sort(), [
        "--channel", "--output", "--format", "--include-threads", "--parallel", "--reverse",
        "--markdown", "--media", "--reuse-media", "--utc", "--respect-rate-limits", "--fuck-russia",
        "--after", "--before", "--partition", "--filter", "--media-dir", "--locale"
    ].sort());
    assert.equal(argumentValue(args, "--respect-rate-limits"), "false");
    assert.equal(argumentValue(args, "--markdown"), "false");
    assert.ok(!args.some(arg => /^(?:--token|--bot|--dateformat)(?:=|$)/.test(arg)));
});

test("untrusted filter/path text remains one argument and cannot introduce options", () => {
    const filter = '-from:"a user" | "--token=x $(touch /tmp/should-not-exist); `id`"';
    const outputPath = "/tmp/exports/space ; $(date) --token=pretend.html";
    const args = buildExportArgs(CHANNEL_ID, options({ filter, outputPath }));
    assert.equal(argumentValue(args, "--filter"), `(${filter})`);
    assert.equal(argumentValue(args, "--output"), outputPath);
    assert.ok(!args.includes("--token=x"));
    assert.throws(() => buildExportArgs("123 --token=x", options()), /channel ID/);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ filter: "bad\0filter" })), /null character/);
    for (const field of ["after", "before", "locale"] as const) {
        for (const value of ["--token", "  --token=pretend", "-t"]) {
            assert.throws(() => buildExportArgs(CHANNEL_ID, options({ [field]: value })), /cannot begin with a dash/);
        }
    }
});

test("malformed native inputs cannot silently disable rate limiting", () => {
    for (const value of [undefined, "false", 0, null]) {
        assert.throws(() => buildExportArgs(CHANNEL_ID, options({ respectRateLimits: value } as unknown as ExportOptions)), /respectRateLimits must be true or false/);
    }
    assert.deepEqual(validateExportOptions(null as unknown as ExportOptions), ["Export options are missing."]);
    assert.ok(validateExportOptions({} as ExportOptions).length > 0);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ format: "--token=x" } as unknown as ExportOptions)), /supported export format/);
});

test("media dependencies and absolute paths are validated before launching DCE", () => {
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ reuseMedia: true })), /Enable Download media/);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ mediaDir: "/tmp/media" })), /Enable Download media/);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ media: true, mediaDir: "relative" })), /absolute media/);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ outputPath: "" })), /Choose an output/);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ outputPath: "chat.html" })), /absolute output/);
    assert.deepEqual(validateExportOptions(options({ outputPath: "\\\\server\\exports\\chat.html" })), []);
});

test("including threads requires a directory or filename template", () => {
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ includeThreads: "Active" })), /When including threads/);
    for (const outputPath of ["/tmp/%G.html", "/tmp/%t.html", "/tmp/%%c.html"]) {
        assert.throws(() => buildExportArgs(CHANNEL_ID, options({ includeThreads: "All", outputPath })), /When including threads/);
    }
    for (const outputPath of ["/tmp/exports/", "C:\\exports\\", "/tmp/exports/%C-%c.html"]) {
        assert.deepEqual(validateExportOptions(options({ includeThreads: "All", outputPath })), []);
    }
});

test("ranges compare snowflakes without losing integer precision and preserve upstream date syntax", () => {
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ after: "123456789012345679", before: "123456789012345678" })), /After must be earlier/);
    assert.deepEqual(validateExportOptions(options({ after: "123456789012345678", before: "123456789012345679" })), []);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ after: "2026-01-01", before: "2025-01-01" })), /After must be earlier/);
    assert.deepEqual(validateExportOptions(options({ after: "17-SEP-2019 23:45:30.6170" })), []);
    assert.throws(() => buildExportArgs(CHANNEL_ID, options({ before: "18446744073709551616" })), /larger than Discord supports/);
    assert.throws(() => buildExportArgs("18446744073709551616", options()), /channel ID/);
    assert.throws(() => buildExportArgs("0", options()), /channel ID/);
});

test("partition and parallel values cannot produce zero-size or invalid export workloads", () => {
    for (const partition of ["0", "-1", "0b", "0.1b", "1tb", "10MiB", "2147483648", "1e3", "100mb; echo no"]) {
        assert.throws(() => buildExportArgs(CHANNEL_ID, options({ partition })), /Partition must be/);
    }
    for (const partition of ["100", "2147483647", "1b", "1.5kb", "10 MB", "2gb"]) {
        assert.deepEqual(validateExportOptions(options({ partition })), []);
    }
    for (const parallel of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
        assert.throws(() => buildExportArgs(CHANNEL_ID, options({ parallel })), /Parallel exports/);
    }
});
