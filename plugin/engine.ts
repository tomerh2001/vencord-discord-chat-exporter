/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { strFromU8, unzipSync } from "fflate";

import { ENGINE_RELEASE } from "./engineRelease";

export interface EngineRelease {
    version: string;
    assets: readonly { rid: string; fileName: string; sha256: string; archiveBytes: number; }[];
}

export interface EngineStatus {
    state: "missing" | "downloading" | "verifying" | "ready" | "failed";
    version: string;
    progress?: number;
    error?: string;
}

interface EngineDependencies {
    root: string;
    platform?: NodeJS.Platform;
    arch?: string;
    musl?: boolean;
    fetch?: typeof fetch;
    release?: EngineRelease;
}

interface ArchiveEntry {
    name: string;
    size: number;
    directory: boolean;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const CANCELLED = "The exporter download was cancelled.";

function hash(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function isMusl(): boolean {
    try {
        const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string; }; };
        return !header.glibcVersionRuntime;
    } catch {
        return false;
    }
}

/** Reject unsupported runtimes explicitly instead of downloading an incompatible executable. */
export function engineRuntime(platform: NodeJS.Platform, arch: string, musl = false): string {
    if (platform === "win32" && ["x64", "arm64", "ia32"].includes(arch))
        return `win-${arch === "ia32" ? "x86" : arch}`;
    if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return `osx-${arch}`;
    if (platform === "linux" && ["x64", "arm64", "arm"].includes(arch)) {
        if (musl && arch !== "x64") throw new Error("DiscordChatExporter does not provide this Linux musl build.");
        return `linux-${musl ? "musl-" : ""}${arch}`;
    }
    throw new Error("DiscordChatExporter does not provide a build for this operating system and processor.");
}

function safeArchiveName(name: string): void {
    const parts = name.replace(/\/$/, "").split("/");
    if (!name || name.length > 1024 || /[\\<>:"|?*\x00-\x1f\x7f]/.test(name) || parts.some(part =>
        !part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || ["__proto__", "prototype", "constructor"].includes(part)))
        throw new Error("The exporter archive contains an unsafe filename.");
}

/** Inspect sizes and Unix file types before fflate allocates decompression buffers. */
function archiveEntries(data: Buffer): ArchiveEntry[] {
    const invalid = () => new Error("The exporter archive is invalid or uses an unsupported ZIP feature.");
    let end = data.length - 22;
    const minimum = Math.max(0, end - 65_535);
    for (; end >= minimum; end--) {
        if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break;
    }
    if (end < minimum || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw invalid();
    const count = data.readUInt16LE(end + 10);
    const centralSize = data.readUInt32LE(end + 12);
    const centralStart = data.readUInt32LE(end + 16);
    if (!count || count > 2048 || count !== data.readUInt16LE(end + 8) || centralStart + centralSize !== end) throw invalid();
    const entries: ArchiveEntry[] = [];
    const names = new Set<string>();
    let total = 0;
    let offset = centralStart;
    for (let i = 0; i < count; i++) {
        if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw invalid();
        const flags = data.readUInt16LE(offset + 8);
        const compression = data.readUInt16LE(offset + 10);
        const compressedSize = data.readUInt32LE(offset + 20);
        const size = data.readUInt32LE(offset + 24);
        const nameLength = data.readUInt16LE(offset + 28);
        const next = offset + 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
        const local = data.readUInt32LE(offset + 42);
        if (next > end || (flags & 1) || ![0, 8].includes(compression) || data.readUInt16LE(offset + 34)
            || local + 30 > centralStart || size > MAX_FILE_BYTES || compressedSize > data.length) throw invalid();
        const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
        const name = strFromU8(rawName, !(flags & 2048));
        safeArchiveName(name);
        const canonical = name.replace(/\/$/, "").toLowerCase();
        if (names.has(canonical)) throw new Error("The exporter archive contains duplicate filenames.");
        names.add(canonical);
        const directory = name.endsWith("/");
        const unixType = (data.readUInt32LE(offset + 38) >>> 16) & 0xf000;
        if (unixType && unixType !== (directory ? 0x4000 : 0x8000))
            throw new Error("The exporter archive contains a link or special file.");
        if (directory && size) throw invalid();
        total += size;
        if (total > MAX_UNPACKED_BYTES) throw new Error("The exporter archive expands beyond the permitted size.");
        if (data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags
            || data.readUInt16LE(local + 8) !== compression || data.readUInt16LE(local + 26) !== nameLength) throw invalid();
        const start = local + 30 + nameLength + data.readUInt16LE(local + 28);
        if (start + compressedSize > centralStart || !data.subarray(local + 30, local + 30 + nameLength).equals(rawName)) throw invalid();
        entries.push({ name, size, directory });
        offset = next;
    }
    if (offset !== end) throw invalid();
    return entries;
}

async function directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The exporter cache contains an unsafe directory.");
}

/** Installs only a reviewed release; no credentials or arbitrary executable paths cross this boundary. */
export class EngineManager {
    private readonly root: string;
    private readonly platform: NodeJS.Platform;
    private readonly release: EngineRelease;
    private readonly fetch: typeof fetch;
    private readonly rid?: string;
    private readonly asset?: EngineRelease["assets"][number];
    private status: EngineStatus;
    private inspection?: Promise<void>;
    private operation?: { owner: number; controller: AbortController; promise: Promise<EngineStatus>; };
    private stopped = false;

    constructor(dependencies: EngineDependencies) {
        this.root = dependencies.root;
        this.platform = dependencies.platform ?? process.platform;
        this.fetch = dependencies.fetch ?? globalThis.fetch;
        this.release = dependencies.release ?? ENGINE_RELEASE;
        this.status = { state: "missing", version: this.release.version };
        try {
            if (!isAbsolute(this.root) || !/^\d+\.\d+(?:\.\d+)?$/.test(this.release.version))
                throw new Error("The exporter cache configuration is invalid.");
            this.rid = engineRuntime(this.platform, dependencies.arch ?? process.arch,
                dependencies.musl ?? (this.platform === "linux" && isMusl()));
            this.asset = this.release.assets.find(asset => asset.rid === this.rid);
            if (!this.asset || this.asset.fileName !== `DiscordChatExporter.Cli.${this.rid}.zip`
                || !/^[a-f0-9]{64}$/.test(this.asset.sha256) || !Number.isSafeInteger(this.asset.archiveBytes)
                || this.asset.archiveBytes < 22 || this.asset.archiveBytes > MAX_ARCHIVE_BYTES)
                throw new Error("A verified DiscordChatExporter release is unavailable for this platform.");
        } catch (error) {
            this.status = { ...this.status, state: "failed", error: (error as Error).message };
        }
    }

    private get cache(): string {
        return join(this.root, this.release.version, this.rid!);
    }

    private get executableName(): string {
        return this.platform === "win32" ? "DiscordChatExporter.Cli.exe" : "DiscordChatExporter.Cli";
    }

    private assertAvailable(): void {
        if (!this.asset || !this.rid) throw new Error(this.status.error ?? "No verified exporter is available.");
        if (this.stopped) throw new Error(CANCELLED);
    }

    private unpack(data: Buffer): { entries: ArchiveEntry[]; files: Record<string, Uint8Array>; } {
        if (data.length !== this.asset!.archiveBytes || hash(data) !== this.asset!.sha256)
            throw new Error("The exporter download failed its SHA-256 integrity check.");
        const entries = archiveEntries(data);
        if (!entries.some(entry => entry.name === this.executableName && !entry.directory))
            throw new Error("The exporter archive does not contain its expected executable.");
        const files = unzipSync(data);
        for (const entry of entries) {
            if (!Object.hasOwn(files, entry.name) || files[entry.name].length !== entry.size)
                throw new Error("The exporter archive contains inconsistent file sizes.");
        }
        return { entries, files };
    }

    private async readVerifiedCache(): Promise<string | null> {
        for (const path of [this.root, join(this.root, this.release.version), this.cache, join(this.cache, "files")]) {
            const info = await lstat(path).catch(error => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (!info) return null;
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The exporter cache contains an unsafe directory.");
        }
        const archivePath = join(this.cache, "archive.zip");
        const info = await lstat(archivePath).catch(() => null);
        if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== this.asset!.archiveBytes)
            throw new Error("The cached exporter archive is missing or damaged. Prepare the exporter again.");
        const { entries, files } = this.unpack(await readFile(archivePath));
        const expected = new Set<string>();
        for (const entry of entries) {
            let name = entry.name.replace(/\/$/, "");
            while (name && name !== ".") {
                expected.add(name);
                name = dirname(name).replaceAll("\\", "/");
            }
            const path = join(this.cache, "files", entry.name);
            const actual = await lstat(path).catch(() => null);
            if (!actual || actual.isSymbolicLink() || (entry.directory ? !actual.isDirectory() : !actual.isFile()))
                throw new Error("The cached exporter files were changed. Prepare the exporter again.");
            if (!entry.directory && (actual.size !== entry.size || hash(await readFile(path)) !== hash(files[entry.name])))
                throw new Error("The cached exporter files failed their integrity check. Prepare the exporter again.");
        }
        const scan = async (relative = "") => {
            for (const file of await readdir(join(this.cache, "files", relative), { withFileTypes: true })) {
                const name = relative ? `${relative}/${file.name}` : file.name;
                if (!expected.has(name) || file.isSymbolicLink() || (!file.isFile() && !file.isDirectory()))
                    throw new Error("The exporter cache contains an unexpected file. Prepare the exporter again.");
                if (file.isDirectory()) await scan(name);
            }
        };
        await scan();
        const executable = join(this.cache, "files", this.executableName);
        await access(executable, this.platform === "win32" ? constants.F_OK : constants.X_OK);
        return executable;
    }

    async getStatus(): Promise<EngineStatus> {
        if (!this.asset || this.operation || this.stopped) return { ...this.status };
        this.inspection ??= (async () => {
            try {
                const executable = await this.readVerifiedCache();
                if (!this.operation && !this.stopped) this.status = { state: executable ? "ready" : "missing", version: this.release.version };
            } catch {
                if (!this.operation && !this.stopped)
                    this.status = { state: "failed", version: this.release.version, error: "The exporter cache needs to be prepared again." };
            }
        })();
        await this.inspection;
        return { ...this.status };
    }

    prepare(owner: number): Promise<EngineStatus> {
        if (this.operation) {
            if (this.operation.owner === owner) return this.operation.promise;
            return Promise.reject(new Error("Another Discord window is preparing the exporter."));
        }
        const controller = new AbortController();
        const promise = Promise.resolve().then(() => this.install(controller.signal)).finally(() => {
            if (this.operation?.controller === controller) this.operation = undefined;
        });
        this.operation = { owner, controller, promise };
        return promise;
    }

    private async download(signal: AbortSignal): Promise<Buffer> {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
        let url = `https://github.com/Tyrrrz/DiscordChatExporter/releases/download/${this.release.version}/${this.asset!.fileName}`;
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || parsed.username || parsed.password
                || (parsed.port && parsed.port !== "443")
                || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname))
                throw new Error("The exporter download redirected to an unexpected location.");
            response = await this.fetch(url, { signal: deadline, redirect: "manual", credentials: "omit" });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirects === 5) throw new Error("The exporter download returned too many redirects.");
            url = new URL(location, url).href;
        }
        if (!response?.ok || !response.body) throw new Error("The official exporter download failed. Try preparing it again.");
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) !== this.asset!.archiveBytes) {
            await response.body.cancel();
            throw new Error("The exporter download has an unexpected size.");
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                deadline.throwIfAborted();
                if (done) break;
                total += value.length;
                if (total > this.asset!.archiveBytes) throw new Error("The exporter download exceeded its expected size.");
                chunks.push(value);
                this.status = { state: "downloading", version: this.release.version, progress: 100 * total / this.asset!.archiveBytes };
            }
        } finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
        return Buffer.concat(chunks, total);
    }

    private async install(signal: AbortSignal): Promise<EngineStatus> {
        let staging: string | undefined;
        try {
            this.assertAvailable();
            signal.throwIfAborted();
            await this.inspection;
            this.inspection = Promise.resolve();
            const existing = await this.readVerifiedCache().catch(() => null);
            signal.throwIfAborted();
            if (existing) {
                this.status = { state: "ready", version: this.release.version };
                return { ...this.status };
            }
            this.status = { state: "downloading", version: this.release.version, progress: 0 };
            const data = await this.download(signal);
            signal.throwIfAborted();
            this.status = { state: "verifying", version: this.release.version };
            const { entries, files } = this.unpack(data);
            await directory(this.root);
            await directory(join(this.root, this.release.version));
            signal.throwIfAborted();
            staging = await mkdtemp(join(this.root, this.release.version, `.install-${this.rid}-`));
            await directory(join(staging, "files"));
            await writeFile(join(staging, "archive.zip"), data, { flag: "wx", mode: 0o600 });
            for (const entry of entries) {
                signal.throwIfAborted();
                const target = join(staging, "files", entry.name);
                if (entry.directory) await directory(target);
                else {
                    await directory(dirname(target));
                    await writeFile(target, files[entry.name], { flag: "wx", mode: 0o600 });
                }
            }
            if (this.platform !== "win32") await chmod(join(staging, "files", this.executableName), 0o700);
            await access(join(staging, "files", this.executableName), this.platform === "win32" ? constants.F_OK : constants.X_OK);
            signal.throwIfAborted();
            await rm(this.cache, { recursive: true, force: true });
            signal.throwIfAborted();
            await rename(staging, this.cache);
            staging = undefined;
            signal.throwIfAborted();
            this.status = { state: "ready", version: this.release.version };
            this.inspection = Promise.resolve();
            return { ...this.status };
        } catch (error) {
            const cancelled = signal.aborted || this.stopped;
            const message = cancelled ? CANCELLED : error instanceof Error ? error.message : "The exporter could not be prepared.";
            this.status = { state: cancelled ? "missing" : "failed", version: this.release.version, ...(cancelled ? {} : { error: message }) };
            throw new Error(message);
        } finally {
            if (staging) await rm(staging, { recursive: true, force: true }).catch(() => { });
        }
    }

    async getVerifiedExecutable(): Promise<string> {
        this.assertAvailable();
        if (this.operation) throw new Error("Wait for the exporter to finish preparing.");
        try {
            const executable = await this.readVerifiedCache();
            if (!executable) throw new Error("Prepare the exporter before exporting a chat.");
            return executable;
        } catch (error) {
            this.status = { state: "failed", version: this.release.version, error: "The exporter cache needs to be prepared again." };
            throw error;
        }
    }

    cancel(owner: number): boolean {
        if (this.operation?.owner !== owner) return false;
        this.operation.controller.abort();
        return true;
    }

    shutdown(): void {
        this.stopped = true;
        this.operation?.controller.abort();
    }
}
