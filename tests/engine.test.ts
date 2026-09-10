import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { EngineManager, EngineRelease, engineRuntime } from "../plugin/engine";

function archive(extra: Record<string, Uint8Array> = {}): Buffer {
    return Buffer.from(zipSync({
        "DiscordChatExporter.Cli": strToU8("synthetic exporter, never executed"),
        "DiscordChatExporter.Cli.dll": strToU8("synthetic managed library"),
        "nested/needed.dll": strToU8("synthetic dependency"),
        ...extra
    }));
}

function release(data: Uint8Array): EngineRelease {
    return {
        version: "2.48",
        assets: [{
            rid: "linux-x64",
            fileName: "DiscordChatExporter.Cli.linux-x64.zip",
            sha256: createHash("sha256").update(data).digest("hex"),
            archiveBytes: data.length
        }]
    };
}

async function harness(t: { after(fn: () => Promise<void>): void; }, data = archive(), fetcher?: typeof fetch) {
    const base = join(import.meta.dirname, "../.cache");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "dce-engine-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const requests: { url: string; init?: RequestInit; }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
        calls++;
        requests.push({ url: String(url), init });
        return fetcher ? fetcher(url, init) : new Response(new Uint8Array(data), { headers: { "Content-Length": String(data.length) } });
    };
    const dependencies = { root, release: release(data), fetch, platform: "linux" as const, arch: "x64", musl: false };
    return { root, requests, calls: () => calls, manager: new EngineManager(dependencies), dependencies };
}

test("selects official desktop runtimes and rejects absent architecture builds", () => {
    assert.equal(engineRuntime("win32", "ia32"), "win-x86");
    assert.equal(engineRuntime("win32", "arm64"), "win-arm64");
    assert.equal(engineRuntime("linux", "arm"), "linux-arm");
    assert.equal(engineRuntime("linux", "x64", true), "linux-musl-x64");
    assert.equal(engineRuntime("darwin", "arm64"), "osx-arm64");
    assert.throws(() => engineRuntime("linux", "arm64", true), /musl/);
    assert.throws(() => engineRuntime("freebsd", "x64"), /operating system/);
});

test("unsupported platform fails visibly without breaking native module construction", async t => {
    const { dependencies } = await harness(t);
    const manager = new EngineManager({ ...dependencies, platform: "freebsd" });
    assert.equal((await manager.getStatus()).state, "failed");
    await assert.rejects(manager.prepare(1), /operating system/);
    await assert.rejects(manager.getVerifiedExecutable(), /operating system/);
});

test("installs a pinned archive without credentials and reuses its verified cache", async t => {
    const { manager, root, requests, calls, dependencies } = await harness(t);
    assert.equal((await manager.getStatus()).state, "missing");
    assert.equal((await manager.prepare(1)).state, "ready");
    const executable = await manager.getVerifiedExecutable();
    assert.equal(executable, join(root, "2.48", "linux-x64", "files", "DiscordChatExporter.Cli"));
    assert.match(await readFile(executable, "utf8"), /synthetic exporter/);
    assert.equal(calls(), 1);
    assert.equal(requests[0].url, "https://github.com/Tyrrrz/DiscordChatExporter/releases/download/2.48/DiscordChatExporter.Cli.linux-x64.zip");
    assert.equal(requests[0].init?.credentials, "omit");
    assert.equal(requests[0].init?.headers, undefined);
    assert.equal(requests[0].init?.body, undefined);
    const restarted = new EngineManager(dependencies);
    assert.equal((await restarted.getStatus()).state, "ready");
    assert.equal((await restarted.prepare(2)).state, "ready");
    assert.equal(calls(), 1, "cached verification never contacts GitHub");
});

test("rejects both changed executable bytes and injected dependency files before execution", async t => {
    const { manager, root, calls } = await harness(t);
    await manager.prepare(1);
    const executable = await manager.getVerifiedExecutable();
    await writeFile(executable, "tampered");
    await assert.rejects(manager.getVerifiedExecutable(), /integrity check/);
    assert.equal((await manager.getStatus()).state, "failed");
    await manager.prepare(1);
    assert.equal(calls(), 2);
    await writeFile(join(root, "2.48", "linux-x64", "files", "injected.dll"), "untrusted");
    await assert.rejects(manager.getVerifiedExecutable(), /unexpected file/);
    await manager.prepare(1);
    assert.match(await readFile(await manager.getVerifiedExecutable(), "utf8"), /synthetic exporter/);
});

test("rejects cached archive tampering even if extracted executable remains unchanged", async t => {
    const { manager, root } = await harness(t);
    await manager.prepare(1);
    const path = join(root, "2.48", "linux-x64", "archive.zip");
    const data = await readFile(path);
    data[0] ^= 1;
    await writeFile(path, data);
    await assert.rejects(manager.getVerifiedExecutable(), /SHA-256/);
});

test("does not trust a cached executable symlink", async t => {
    const { manager, root } = await harness(t);
    await manager.prepare(1);
    const executable = await manager.getVerifiedExecutable();
    const alternate = join(root, "elsewhere");
    await writeFile(alternate, await readFile(executable));
    await rm(executable);
    await symlink(alternate, executable);
    await assert.rejects(manager.getVerifiedExecutable(), /changed/);
});

test("rejects a same-size download whose pinned digest does not match", async t => {
    const data = archive();
    const changed = Buffer.from(data);
    changed[0] ^= 1;
    const { manager, root } = await harness(t, data, async () => new Response(new Uint8Array(changed)));
    await assert.rejects(manager.prepare(1), /SHA-256/);
    assert.equal((await manager.getStatus()).state, "failed");
    assert.deepEqual(await readdir(root), []);
});

test("bounds downloads with and without Content-Length", async t => {
    const data = archive();
    for (const headers of [undefined, { "Content-Length": String(data.length + 1) }]) {
        const { manager } = await harness(t, data, async () => new Response(Buffer.concat([data, Buffer.from([0])]), { headers }));
        await assert.rejects(manager.prepare(1), /size/);
    }
    const { manager } = await harness(t, data, async () => new Response(new Uint8Array(data.subarray(0, data.length - 1))));
    await assert.rejects(manager.prepare(1), /SHA-256/);
});

test("permits only expected HTTPS GitHub release redirects", async t => {
    const data = archive();
    let count = 0;
    const { manager } = await harness(t, data, async () => ++count === 1
        ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset" } })
        : new Response(new Uint8Array(data)));
    await manager.prepare(1);
    assert.equal(count, 2);
    for (const location of ["http://github.com/file", "https://example.org/file", "https://github.com:444/file", "https://secret@github.com/file"]) {
        const { manager } = await harness(t, data, async () => new Response(null, { status: 302, headers: { location } }));
        await assert.rejects(manager.prepare(1), /unexpected location/);
    }
});

test("rejects traversal, absolute paths, Windows aliases, and file links in authenticated ZIPs", async t => {
    for (const name of ["../escape", "/absolute", "C:/escape", "parent\\escape", "foo/../escape", "CON.txt", "file:stream", "trailing. "]) {
        const { manager, root } = await harness(t, archive({ [name]: strToU8("invalid") }));
        await assert.rejects(manager.prepare(1), /unsafe filename/);
        assert.deepEqual(await readdir(root), []);
    }
    const linked = archive();
    const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    linked.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
    const { manager } = await harness(t, linked);
    await assert.rejects(manager.prepare(1), /link or special file/);
});

test("rejects ZIP expansion bombs from central sizes before allocating file buffers", async t => {
    const data = archive();
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    data.writeUInt32LE(0x7fffffff, central + 24);
    const { manager } = await harness(t, data);
    await assert.rejects(manager.prepare(1), /invalid or uses an unsupported ZIP feature/);
});

test("a download failure can be retried and leaves no partial installation", async t => {
    const data = archive();
    let attempts = 0;
    const { manager, root } = await harness(t, data, async () => ++attempts === 1
        ? new Response("unavailable", { status: 503 }) : new Response(new Uint8Array(data)));
    await assert.rejects(manager.prepare(1), /download failed/);
    assert.deepEqual(await readdir(root), []);
    assert.equal((await manager.prepare(1)).state, "ready");
    assert.deepEqual(await readdir(join(root, "2.48")), ["linux-x64"]);
});

test("only the owning window cancels preparation and cancellation cannot publish ready", async t => {
    const data = archive();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { manager, root } = await harness(t, data, async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        entered();
    }));
    const pending = manager.prepare(1);
    const rejected = assert.rejects(pending, /cancelled/);
    await started;
    assert.equal(manager.prepare(1), pending, "same owner shares its in-flight promise");
    await assert.rejects(manager.prepare(2), /Another Discord window/);
    assert.equal(manager.cancel(2), false);
    assert.equal((await manager.getStatus()).state, "downloading");
    assert.equal(manager.cancel(1), true);
    await rejected;
    assert.equal((await manager.getStatus()).state, "missing");
    assert.deepEqual(await readdir(root), []);
});

test("shutdown prevents future preparation and executable retrieval", async t => {
    const { manager, calls } = await harness(t);
    manager.shutdown();
    await assert.rejects(manager.prepare(1), /cancelled/);
    await assert.rejects(manager.getVerifiedExecutable(), /cancelled/);
    assert.equal(calls(), 0);
});
