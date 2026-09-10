import assert from "node:assert/strict";
import { ChildProcess, SpawnOptions, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildExportArgs, createDefaultOptions } from "../plugin/options";
import { ExportRequest, ExportRunner, normalizeExportPaths, SafeLogStream } from "../plugin/runner";

const TOKEN = "mfa.synthetic-test-token-never-real-1234567890";
const HELP = `DiscordChatExporter.Cli v2.48.0
--channel --output --format --after --before --partition --include-threads
--filter --parallel --reverse --markdown --media --reuse-media --media-dir
--locale --utc --respect-rate-limits --fuck-russia --token DISCORD_TOKEN`;

class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid: number | undefined = 12345;
    signals: string[] = [];
    kill(signal = "SIGTERM") {
        this.signals.push(signal);
        return true;
    }
    close(code: number | null = 0) {
        this.emit("close", code, null);
    }
}

interface SpawnCall {
    executable: string;
    args: string[];
    options: SpawnOptions;
    env: NodeJS.ProcessEnv;
    child: FakeChild;
}

function harness(options: { help?: string; version?: string; manualProbe?: boolean; spawnError?: boolean } = {}) {
    const calls: SpawnCall[] = [];
    const spawn = (executable: string, args: string[], spawnOptions: SpawnOptions) => {
        if (options.spawnError) throw new Error(`An underlying error could contain ${TOKEN}`);
        const child = new FakeChild();
        calls.push({ executable, args, options: spawnOptions, env: { ...spawnOptions.env }, child });
        if ((args.includes("--version") || args.includes("--help")) && !options.manualProbe) {
            queueMicrotask(() => {
                child.stdout.write(args.includes("--version") ? options.version ?? "DiscordChatExporter.Cli v2.48.0\n" : options.help ?? HELP);
                child.close();
            });
        }
        return child as unknown as ChildProcess;
    };
    return { calls, runner: new ExportRunner({ spawn, cancelGraceMs: 10, probeTimeoutMs: 100, maxLogChars: 300 }) };
}

function request(): ExportRequest {
    return {
        executablePath: process.execPath,
        channelId: "123456789012345678",
        token: TOKEN,
        options: { ...createDefaultOptions(), outputPath: "/tmp/test-chat-export/" }
    };
}

function optionValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `${flag} is passed as its own argument`);
    return args[index + 1];
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await delay(1);
    }
    assert.fail("Condition did not become true");
}

test("token travels only in the export child environment; probes never inherit it", async () => {
    const oldToken = process.env.DISCORD_TOKEN;
    const oldBot = process.env.DISCORD_TOKEN_BOT;
    process.env.DISCORD_TOKEN = "ambient-secret-must-not-reach-probes";
    process.env.DISCORD_TOKEN_BOT = "1";
    try {
        const { runner, calls } = harness();
        const job = await runner.start(1, request());
        assert.equal(job.state, "running");
        assert.equal(job.channelId, "123456789012345678");
        assert.equal(calls.length, 3);
        for (const call of calls) {
            assert.equal(call.options.shell, false);
            assert.equal(call.options.windowsHide, true);
            assert.equal(call.args.some(arg => arg.includes(TOKEN)), false);
            assert.equal(call.env.DISCORD_TOKEN_BOT, undefined);
        }
        assert.equal(calls[0].env.DISCORD_TOKEN, undefined);
        assert.equal(calls[1].env.DISCORD_TOKEN, undefined);
        assert.equal(calls[2].env.DISCORD_TOKEN, TOKEN);
        assert.equal(calls[2].options.env?.DISCORD_TOKEN, undefined, "parent clears ephemeral spawn env immediately");
        assert.equal(optionValue(calls[2].args, "--respect-rate-limits"), "true");
        assert.equal(optionValue(calls[2].args, "--parallel"), "1");
        calls[2].child.close();
        assert.equal(runner.getJob(1)?.state, "completed");
        assert.equal(process.env.DISCORD_TOKEN, "ambient-secret-must-not-reach-probes");
    } finally {
        if (oldToken === undefined) delete process.env.DISCORD_TOKEN;
        else process.env.DISCORD_TOKEN = oldToken;
        if (oldBot === undefined) delete process.env.DISCORD_TOKEN_BOT;
        else process.env.DISCORD_TOKEN_BOT = oldBot;
    }
});

test("stream redaction never leaks a token split at any chunk boundary", () => {
    for (let split = 1; split < TOKEN.length; split++) {
        const stream = new SafeLogStream(TOKEN);
        const first = stream.push(`before ${TOKEN.slice(0, split)}`);
        assert.equal(first, "before ");
        const second = stream.push(`${TOKEN.slice(split)} after`);
        const end = stream.push("", true);
        assert.equal(first + second + end, "before [REDACTED] after");
    }
});

test("stream redaction handles ANSI controls and Unicode split between chunks", () => {
    const stream = new SafeLogStream(TOKEN);
    const buffers = [Buffer.from("היי "), Buffer.from(`\u001b[31m${TOKEN.slice(0, 12)}\u001b[0m${TOKEN.slice(12)}\u001b]8;;https://example.invalid\u0007 visible\u001b]8;;\u001b\\`)];
    const bytes = Buffer.concat(buffers);
    let output = "";
    for (const byte of bytes) output += stream.push(Buffer.from([byte]));
    output += stream.push("", true);
    assert.equal(output, "היי [REDACTED] visible");
    assert.equal(output.includes("\u001b"), false);
});

test("job output is redacted independently on stdout and stderr and bounded", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    const child = calls[2].child;
    child.stdout.write(`Working ${TOKEN.slice(0, 10)}`);
    assert.equal(runner.getJob(1)?.log, "Working ");
    child.stderr.write(`Problem ${TOKEN.slice(0, 20)}`);
    child.stdout.write(TOKEN.slice(10));
    child.stderr.write(TOKEN.slice(20));
    assert.equal(runner.getJob(1)?.log?.includes(TOKEN), false);
    assert.match(runner.getJob(1)?.log ?? "", /\[REDACTED\]/);
    child.stdout.write("x".repeat(1000));
    assert.ok((runner.getJob(1)?.log.length ?? 0) <= 300);
    child.close(0);
    assert.equal(runner.getJob(1)?.state, "completedWithWarnings");
    assert.ok(runner.getJob(1)?.finishedAt);
});

test("partial failures with a successful exit remain visible even after log truncation", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    calls[2].child.stdout.write("Successfully exported 1 channel(s).\nFailed to export the following ");
    calls[2].child.stdout.write("channel(s):\nOne thread was inaccessible.\n" + "x".repeat(1000));
    calls[2].child.close(0);
    assert.equal(runner.getJob(1)?.state, "completedWithWarnings");
});

test("nonzero exit and process errors produce safe failures", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    calls[2].child.close(1);
    assert.equal(runner.getJob(1)?.state, "failed");
    assert.equal(runner.getJob(1)?.exitCode, 1);
    await runner.start(1, request());
    calls[5].child.pid = undefined;
    calls[5].child.emit("error", new Error(TOKEN));
    assert.equal(runner.getJob(1)?.state, "failed");
    assert.equal(runner.getJob(1)?.log.includes(TOKEN), false);
});

test("an error from a running child keeps the global reservation until close", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    calls[2].child.emit("error", new Error(TOKEN));
    assert.equal(runner.getJob(1)?.state, "running");
    assert.equal(runner.getJob(1)?.log.includes(TOKEN), false);
    await assert.rejects(runner.start(2, request()), /already starting or running/);
    calls[2].child.close(1);
    assert.equal(runner.getJob(1)?.state, "failed");
});

test("single global job reservation prevents races and enforces sender ownership", async () => {
    const { runner, calls } = harness();
    const starting = runner.start(1, request());
    await assert.rejects(runner.start(2, request()), /already starting or running/);
    await starting;
    assert.equal(runner.getJob(2), null);
    runner.cancel(2);
    assert.deepEqual(calls[2].child.signals, []);
    await assert.rejects(runner.start(2, request()), /already starting or running/);
    const snapshot = runner.getJob(1)!;
    snapshot.log = "mutated outside runner";
    assert.equal(runner.getJob(1)?.log, "");
    calls[2].child.close();
    assert.equal((await runner.start(2, request())).state, "running");
    calls[5].child.close();
});

test("cancellation sends an interrupt then forces a stubborn process to stop", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    runner.cancel(1);
    assert.deepEqual(calls[2].child.signals, ["SIGINT"]);
    assert.equal(runner.getJob(1)?.state, "running", "reserve job until the process actually closes");
    await delay(25);
    assert.deepEqual(calls[2].child.signals, ["SIGINT", "SIGKILL"]);
    calls[2].child.close(null);
    assert.equal(runner.getJob(1)?.state, "cancelled");
    assert.match(runner.getJob(1)?.log ?? "", /may be incomplete/);
});

test("a gracefully cancelled process does not receive a late forced kill", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    runner.cancel(1);
    calls[2].child.close(0);
    await delay(25);
    assert.deepEqual(calls[2].child.signals, ["SIGINT"]);
    assert.equal(runner.getJob(1)?.state, "cancelled");
});

test("cleanup during the compatibility probe cannot later launch an export", async () => {
    const { runner, calls } = harness({ manualProbe: true });
    const starting = runner.start(1, request());
    const rejected = assert.rejects(starting, /cancelled/);
    await waitFor(() => calls.length === 1);
    runner.cancel(1);
    assert.deepEqual(calls[0].child.signals, ["SIGKILL"]);
    calls[0].child.stdout.write("2.48.0");
    calls[0].child.close(0);
    await rejected;
    assert.equal(calls.length, 1);
    assert.equal(runner.getJob(1), null);
});

test("shutdown forcibly stops active children", async () => {
    const { runner, calls } = harness();
    await runner.start(1, request());
    runner.shutdown();
    assert.deepEqual(calls[2].child.signals, ["SIGKILL"]);
    calls[2].child.close(null);
    assert.equal(runner.getJob(1)?.state, "cancelled");
});

test("unknown versions or missing rate-limit capability prevent export spawning", async () => {
    const oldVersion = harness({ version: "DiscordChatExporter.Cli v2.47.0" });
    await assert.rejects(oldVersion.runner.start(1, request()), /supports DiscordChatExporter CLI 2.48/);
    assert.equal(oldVersion.calls.length, 1);
    const missingFlag = harness({ help: HELP.replace("--respect-rate-limits", "--unsupported") });
    await assert.rejects(missingFlag.runner.start(1, request()), /required export options/);
    assert.equal(missingFlag.calls.length, 2);
    const missingEnv = harness({ help: HELP.replace("DISCORD_TOKEN", "unknown") });
    await assert.rejects(missingEnv.runner.start(1, request()), /DISCORD_TOKEN support/);
    assert.equal(missingEnv.calls.length, 2);
});

test("validation rejects relative output, shell scripts, and invalid tokens without spawning", async () => {
    const { runner, calls } = harness();
    const relative = request();
    relative.options.outputPath = "relative/output.html";
    await assert.rejects(runner.start(1, relative), /absolute/);
    await assert.rejects(runner.start(1, { ...request(), executablePath: "/tmp/exporter.sh" }), /shell script/);
    await assert.rejects(runner.start(1, { ...request(), token: "" }), /valid Discord token/);
    await assert.rejects(runner.start(1, { ...request(), token: "secret\nvalue" }), /valid Discord token/);
    assert.equal(calls.length, 0);
});

test("effective paths agree for overwrite validation, export arguments, and saved job snapshots", async () => {
    const { runner, calls } = harness();
    const input = request();
    input.options.outputPath = "  /tmp/existing-export.html \t";
    input.options.media = true;
    input.options.mediaDir = "  /tmp/export-media/ \t";
    const normalized = normalizeExportPaths(input.options);
    assert.equal(normalized.outputPath, "/tmp/existing-export.html");
    assert.equal(normalized.mediaDir, "/tmp/export-media/");
    const job = await runner.start(1, input);
    assert.equal(job.outputPath, normalized.outputPath);
    assert.equal(runner.getJob(1)?.outputPath, normalized.outputPath);
    assert.equal(optionValue(calls[2].args, "--output"), normalized.outputPath);
    assert.equal(optionValue(calls[2].args, "--media-dir"), normalized.mediaDir);
    assert.equal(input.options.outputPath, "  /tmp/existing-export.html \t", "the caller's object is not mutated");
    calls[2].child.close();
});

test("path normalization keeps malformed IPC option errors instead of coercing values", () => {
    assert.throws(() => normalizeExportPaths(undefined as never), /Export options are missing/);
    assert.throws(() => normalizeExportPaths({ ...createDefaultOptions(), outputPath: 123 } as never), /outputPath must be text/);
    assert.throws(() => normalizeExportPaths({ ...createDefaultOptions(), mediaDir: null } as never), /mediaDir must be text/);
});

test("underlying spawn errors never expose raw error text", async () => {
    const { runner } = harness({ spawnError: true });
    await assert.rejects(runner.start(1, request()), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
    });
});

test("official CLI passes real offline version and capability probes", { skip: !process.env.DCE_EXECUTABLE }, async () => {
    const runner = new ExportRunner();
    const info = await runner.checkExporter(1, process.env.DCE_EXECUTABLE!);
    assert.match(info.version, /^2\.48(?:\.\d+)?$/);
    assert.match(info.help, /--respect-rate-limits/);
});

test("official CLI accepts complete export argv and negated filters before requiring the absent token", { skip: !process.env.DCE_EXECUTABLE }, () => {
    const env = { ...process.env, NO_COLOR: "1", TERM: "dumb" } as NodeJS.ProcessEnv;
    delete env.DISCORD_TOKEN;
    delete env.DISCORD_TOKEN_BOT;
    delete env.FORCE_COLOR;
    for (const filter of ["", "-has:link", "-from:someone"]) {
        const options = {
            ...createDefaultOptions(), outputPath: "/tmp/offline-cli-parser-check/", format: "Json" as const,
            after: "2024-01-01", before: "2024-02-01", partition: "10mb", includeThreads: "All" as const,
            filter, parallel: 2, reverse: true, markdown: false, media: true, reuseMedia: true,
            mediaDir: "/tmp/offline-cli-parser-media/", locale: "en-US", utc: true,
            respectRateLimits: true, suppressUkraineMessage: true
        };
        const args = buildExportArgs("123456789012345678", options);
        assert.equal(args.includes("--help"), false, "help bypasses argument validation and is not a parser test");
        assert.equal(args.includes("--token"), false, "no authentication is supplied to the offline parser check");
        const result = spawnSync(process.env.DCE_EXECUTABLE!, args, { env, shell: false, encoding: "utf8", timeout: 5000 });
        assert.ifError(result.error);
        assert.equal(result.status, 1, `CLI must stop at the missing token for filter ${JSON.stringify(filter)}`);
        assert.match(result.stderr, /Missing required option\(s\):/);
        assert.match(result.stderr, /-t\|--token/);
        assert.doesNotMatch(result.stderr + result.stdout, /Unrecognized option/i);
        assert.equal(result.stderr.replace(/\r\n/g, "\n").trim(), "Missing required option(s):\n-t|--token", "the token must be the only parser complaint");
    }

    // A bad numeric value must reach its converter. This proves the no-token check
    // exercises binding, unlike --help, which would silently bypass these errors.
    const invalidArgs = buildExportArgs("123456789012345678", { ...createDefaultOptions(), outputPath: "/tmp/offline-cli-parser-check/" });
    invalidArgs[invalidArgs.indexOf("--parallel") + 1] = "not-an-integer";
    const invalidResult = spawnSync(process.env.DCE_EXECUTABLE!, invalidArgs, { env, shell: false, encoding: "utf8", timeout: 5000 });
    assert.ifError(invalidResult.error);
    assert.equal(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /FormatException/);
    assert.doesNotMatch(invalidResult.stderr, /Unrecognized option|Missing required option/);
});
