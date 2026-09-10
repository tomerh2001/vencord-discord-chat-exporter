/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { buildExportArgs, ExportOptions, validateExportOptions } from "./options";

export type JobState = "running" | "completed" | "completedWithWarnings" | "failed" | "cancelled";

export interface JobSnapshot {
    id: string;
    channelId: string;
    state: JobState;
    log: string;
    outputPath: string;
    startedAt: number;
    finishedAt?: number;
    exitCode?: number | null;
}

export interface ExportRequest {
    executablePath: string;
    channelId: string;
    options: ExportOptions;
    token: string;
}

export interface ExporterInfo {
    version: string;
    help: string;
}

export const REQUIRED_FLAGS = [
    "channel", "output", "format", "after", "before", "partition", "include-threads",
    "filter", "parallel", "reverse", "markdown", "media", "reuse-media", "media-dir",
    "locale", "utc", "respect-rate-limits", "fuck-russia", "token"
] as const;

/** Keep overwrite checks, process arguments, snapshots, and output reveal on the same paths. */
export function normalizeExportPaths(options: ExportOptions): ExportOptions {
    const errors = validateExportOptions(options);
    if (errors.length) throw new Error(errors.join("\n"));
    return { ...options, outputPath: options.outputPath.trim(), mediaDir: options.mediaDir.trim() };
}

type SpawnFunction = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

interface RunnerDependencies {
    spawn?: SpawnFunction;
    probeTimeoutMs?: number;
    cancelGraceMs?: number;
    maxLogChars?: number;
}

interface Job {
    owner: number;
    child: ChildProcess;
    snapshot: JobSnapshot;
    cancelled: boolean;
    warnings: boolean;
    killTimer?: ReturnType<typeof setTimeout>;
}

/** Removes terminal controls incrementally, including escape sequences split across chunks. */
class TerminalText {
    private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
    private decoder = new StringDecoder("utf8");

    push(chunk: Buffer | string, final = false): string {
        const input = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        let output = "";
        for (const ch of input + (final ? this.decoder.end() : "")) {
            const code = ch.charCodeAt(0);
            if (this.state === "escape") {
                this.state = ch === "[" ? "csi" : "]PX^_".includes(ch) ? "string" : "text";
            } else if (this.state === "csi") {
                if (code >= 0x40 && code <= 0x7e) this.state = "text";
            } else if (this.state === "string") {
                if (code === 7 || code === 0x9c) this.state = "text";
                else if (code === 0x1b) this.state = "stringEscape";
            } else if (this.state === "stringEscape") {
                this.state = ch === "\\" ? "text" : "string";
            } else if (code === 0x1b) {
                this.state = "escape";
            } else if (code === 0x9b) {
                this.state = "csi";
            } else if (code === 0x9d || code === 0x90) {
                this.state = "string";
            } else if (ch === "\r") {
                output += "\n";
            } else if (ch === "\n" || ch === "\t" || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) {
                output += ch;
            }
        }
        return output;
    }
}

/** Holds any possible token prefix until it can be safely emitted or redacted. */
export class SafeLogStream {
    private terminal = new TerminalText();
    private pending = "";

    constructor(private secret: string) { }

    push(chunk: Buffer | string, final = false): string {
        let text = this.pending + this.terminal.push(chunk, final);
        if (this.secret) text = text.split(this.secret).join("[REDACTED]");
        let retained = 0;
        for (let length = Math.min(this.secret.length - 1, text.length); length > 0; length--) {
            if (text.endsWith(this.secret.slice(0, length))) {
                retained = length;
                break;
            }
        }
        this.pending = retained ? text.slice(-retained) : "";
        const output = retained ? text.slice(0, -retained) : text;
        if (!final) return output;
        const tail = this.pending ? "[REDACTED]" : "";
        this.pending = "";
        this.secret = "";
        return output + tail;
    }
}

function childEnvironment(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
    delete env.DISCORD_TOKEN;
    delete env.DISCORD_TOKEN_BOT;
    delete env.FORCE_COLOR;
    if (token !== undefined) env.DISCORD_TOKEN = token;
    return env;
}

async function executableFile(path: string): Promise<string> {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
        throw new Error("Choose the full path to the official DiscordChatExporter CLI executable.");
    if (/\.(?:bat|cmd|ps1|sh)$/i.test(path))
        throw new Error("Choose the DiscordChatExporter CLI executable itself, not a shell script.");
    try {
        const resolved = await realpath(path);
        if (!(await stat(resolved)).isFile()) throw new Error();
        await access(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return resolved;
    } catch {
        throw new Error("The exporter executable is missing or cannot be executed.");
    }
}

/** One export globally, with snapshots and cancellation restricted to the originating window. */
export class ExportRunner {
    private readonly spawn: SpawnFunction;
    private readonly probeTimeoutMs: number;
    private readonly cancelGraceMs: number;
    private readonly maxLogChars: number;
    private job: Job | null = null;
    private pendingOwner: number | null = null;
    private epochs = new Map<number, number>();
    private probes = new Map<ChildProcess, number>();

    constructor(dependencies: RunnerDependencies = {}) {
        this.spawn = dependencies.spawn ?? spawn;
        this.probeTimeoutMs = dependencies.probeTimeoutMs ?? 15_000;
        this.cancelGraceMs = dependencies.cancelGraceMs ?? 5_000;
        this.maxLogChars = dependencies.maxLogChars ?? 64_000;
    }

    private epoch(owner: number) {
        return this.epochs.get(owner) ?? 0;
    }

    private assertCurrent(owner: number, epoch: number) {
        if (this.epoch(owner) !== epoch) throw new Error("The exporter operation was cancelled.");
    }

    private probe(owner: number, executable: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            let child: ChildProcess;
            const env = childEnvironment();
            try {
                child = this.spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            } catch {
                reject(new Error("The exporter could not be started for its offline compatibility check."));
                return;
            }
            this.probes.set(child, owner);
            const stdout = new SafeLogStream("");
            const stderr = new SafeLogStream("");
            let output = "";
            let settled = false;
            const finish = (error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.probes.delete(child);
                if (error) reject(new Error(error));
                else resolve(output + stdout.push("", true) + stderr.push("", true));
            };
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish("The exporter's offline compatibility check timed out.");
            }, this.probeTimeoutMs);
            timer.unref?.();
            const collect = (stream: SafeLogStream, chunk: Buffer) => {
                if (settled) return;
                output += stream.push(chunk);
                if (output.length > 256_000) {
                    child.kill("SIGKILL");
                    finish("The exporter returned too much output during its compatibility check.");
                }
            };
            child.stdout?.on("data", chunk => collect(stdout, chunk));
            child.stderr?.on("data", chunk => collect(stderr, chunk));
            child.on("error", () => finish("The exporter could not complete its offline compatibility check."));
            child.once("close", code => finish(code === 0 ? undefined : "The exporter's offline compatibility check failed."));
        });
    }

    private async inspect(owner: number, executable: string, epoch: number): Promise<ExporterInfo> {
        const rawVersion = await this.probe(owner, executable, ["--version"]);
        this.assertCurrent(owner, epoch);
        const match = rawVersion.match(/(?:^|\s)v?(2\.48(?:\.\d+)?)(?:\+[\w.-]+)?(?=\s|$)/i);
        if (!match) throw new Error("This plugin supports DiscordChatExporter CLI 2.48.x. Choose that release before exporting.");
        const help = await this.probe(owner, executable, ["export", "--help"]);
        this.assertCurrent(owner, epoch);
        const missing = REQUIRED_FLAGS.filter(flag => !new RegExp(`--${flag}(?=[\\s=,\\[<]|$)`).test(help));
        if (missing.length || !help.includes("DISCORD_TOKEN"))
            throw new Error("This exporter does not advertise all required export options and DISCORD_TOKEN support. Choose the official CLI 2.48.x release.");
        return { version: match[1], help };
    }

    async checkExporter(owner: number, path: string): Promise<ExporterInfo> {
        const epoch = this.epoch(owner);
        const executable = await executableFile(path);
        this.assertCurrent(owner, epoch);
        return this.inspect(owner, executable, epoch);
    }

    async start(owner: number, request: ExportRequest): Promise<JobSnapshot> {
        if (this.pendingOwner !== null || this.job?.snapshot.state === "running")
            throw new Error("Another export is already starting or running. Wait for it to finish or cancel it first.");
        this.pendingOwner = owner;
        const epoch = this.epoch(owner);
        try {
            if (!request || typeof request.token !== "string" || !request.token.trim() || request.token.length > 4096 || /[\s\0]/.test(request.token))
                throw new Error("A valid Discord token is required for this export.");
            const options = normalizeExportPaths(request.options);
            const args = buildExportArgs(request.channelId, options);
            if (!isAbsolute(options.outputPath) || (options.mediaDir && !isAbsolute(options.mediaDir)))
                throw new Error("Choose absolute paths for the export and any custom media folder.");
            const executable = await executableFile(request.executablePath);
            this.assertCurrent(owner, epoch);
            await this.inspect(owner, executable, epoch);
            this.assertCurrent(owner, epoch);
            const stdout = new SafeLogStream(request.token);
            const stderr = new SafeLogStream(request.token);
            const env = childEnvironment(request.token);
            let child: ChildProcess;
            try {
                child = this.spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            } catch {
                stdout.push("", true);
                stderr.push("", true);
                throw new Error("The exporter process could not be started.");
            } finally {
                delete env.DISCORD_TOKEN;
            }
            const job: Job = {
                owner, child, cancelled: false, warnings: false,
                snapshot: { id: randomUUID(), channelId: request.channelId, state: "running", log: "", outputPath: options.outputPath, startedAt: Date.now() }
            };
            this.job = job;
            let detectorTail = "";
            const append = (text: string, isError = false) => {
                if (isError && text.trim()) job.warnings = true;
                const detectable = detectorTail + text;
                if (/Warnings reported for the following channel|Failed to export the following channel|\bwarning:/i.test(detectable))
                    job.warnings = true;
                detectorTail = detectable.slice(-150);
                job.snapshot.log = (job.snapshot.log + text).slice(-this.maxLogChars);
            };
            const finish = (code: number | null, error = false) => {
                if (job.snapshot.state !== "running") return;
                clearTimeout(job.killTimer);
                append(stdout.push("", true));
                append(stderr.push("", true), true);
                job.snapshot.finishedAt = Date.now();
                job.snapshot.exitCode = code;
                job.snapshot.state = job.cancelled ? "cancelled" : error || code !== 0 ? "failed" : job.warnings ? "completedWithWarnings" : "completed";
                if (error) append("\nThe exporter process failed to start or stopped unexpectedly.\n");
                else if (job.cancelled) append("\nExport cancelled. Any files already written may be incomplete.\n");
            };
            child.stdout?.on("data", chunk => {
                if (job.snapshot.state === "running") append(stdout.push(chunk));
            });
            child.stderr?.on("data", chunk => {
                if (job.snapshot.state === "running") append(stderr.push(chunk), true);
            });
            child.on("error", () => {
                if (!child.pid) finish(null, true);
                else if (job.snapshot.state === "running") {
                    job.warnings = true;
                    append("\nThe exporter process reported an error. Waiting for it to stop.\n");
                }
            });
            child.once("close", code => finish(code));
            return { ...job.snapshot };
        } finally {
            this.pendingOwner = null;
        }
    }

    isBusy(): boolean {
        return this.pendingOwner !== null || this.job?.snapshot.state === "running";
    }

    getJob(owner: number): JobSnapshot | null {
        return this.job?.owner === owner ? { ...this.job.snapshot } : null;
    }

    cancel(owner: number): void {
        this.epochs.set(owner, this.epoch(owner) + 1);
        for (const [child, childOwner] of this.probes) {
            if (childOwner === owner) child.kill("SIGKILL");
        }
        const { job } = this;
        if (!job || job.owner !== owner || job.snapshot.state !== "running" || job.cancelled) return;
        job.cancelled = true;
        // On Windows Node terminates the child immediately; Unix gets a graceful interrupt first.
        job.child.kill("SIGINT");
        job.killTimer = setTimeout(() => {
            if (job.snapshot.state === "running") job.child.kill("SIGKILL");
        }, this.cancelGraceMs);
        job.killTimer.unref?.();
    }

    shutdown(): void {
        for (const child of this.probes.keys()) child.kill("SIGKILL");
        if (this.pendingOwner !== null) this.epochs.set(this.pendingOwner, this.epoch(this.pendingOwner) + 1);
        const { job } = this;
        if (job?.snapshot.state === "running") {
            job.cancelled = true;
            clearTimeout(job.killTimer);
            job.child.kill("SIGKILL");
        }
    }
}
