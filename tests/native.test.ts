import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

import type { EngineStatus } from "../plugin/engine";
import { createDefaultOptions } from "../plugin/options";
import type { ExportOptions } from "../plugin/options";
import type { ExportRequest, JobSnapshot } from "../plugin/runner";

const MANAGED_PATH = "/synthetic-vencord-data/DiscordChatExporter/2.48/verified/DiscordChatExporter.Cli";
const nativeSource = readFileSync(new URL("../plugin/native.ts", import.meta.url), "utf8");
const nativeCode = transformSync(nativeSource, { loader: "ts", format: "cjs", target: "node22" }).code;
const requireBuiltin = createRequire(import.meta.url);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await nextTurn();
    }
    assert.fail("Expected operation did not start");
}

class Sender extends EventEmitter {
    destroyed = false;
    constructor(readonly id: number) { super(); }
    isDestroyed() { return this.destroyed; }
}

type IpcEvent = { sender: Sender; };
interface NativeApi {
    getEngineStatus(event: IpcEvent): Promise<EngineStatus>;
    prepareEngine(event: IpcEvent): Promise<EngineStatus>;
    cancelEngineSetup(event: IpcEvent): Promise<void>;
    startExport(event: IpcEvent, request: Omit<ExportRequest, "executablePath">): Promise<JobSnapshot>;
    getJob(event: IpcEvent): Promise<JobSnapshot | null>;
    cancelExport(event: IpcEvent): Promise<void>;
    cleanup(event: IpcEvent): Promise<void>;
}

function harness() {
    const engine = {
        status: { state: "ready", version: "2.48" } as EngineStatus,
        downloadOwner: null as number | null,
        verifyCalls: 0,
        prepareCalls: [] as number[],
        cancelCalls: [] as number[],
        readStatus: async (): Promise<EngineStatus> => ({ ...engine.status }),
        verify: async () => MANAGED_PATH,
        async getStatus() { return engine.readStatus(); },
        async getVerifiedExecutable() {
            engine.verifyCalls++;
            return engine.verify();
        },
        async prepare(owner: number) {
            engine.prepareCalls.push(owner);
            engine.status = { state: "ready", version: "2.48" };
            return { ...engine.status };
        },
        cancel(owner: number) {
            engine.cancelCalls.push(owner);
            if (engine.downloadOwner !== owner) return false;
            engine.downloadOwner = null;
            engine.status = { state: "missing", version: "2.48" };
            return true;
        },
        shutdown() {}
    };
    const probes: { owner: number; executablePath: string; }[] = [];
    const starts: { owner: number; request: ExportRequest; runner: FakeRunner; }[] = [];
    const cancellations: { owner: number; runner: FakeRunner; }[] = [];
    const hooks = {
        inspect: async (_owner: number) => ({ version: "2.48", help: "synthetic offline help" }),
        stat: async (_path: string): Promise<{ isFile(): boolean; } | null> => null,
        showMessageBox: async () => ({ response: 1 }),
        prompts: 0
    };

    class FakeRunner {
        job: JobSnapshot | null = null;
        jobOwner: number | null = null;
        async checkExporter(owner: number, executablePath: string) {
            probes.push({ owner, executablePath });
            return hooks.inspect(owner);
        }
        async start(owner: number, request: ExportRequest) {
            starts.push({ owner, request, runner: this });
            this.jobOwner = owner;
            this.job = {
                id: "synthetic-job", channelId: request.channelId, outputPath: request.options.outputPath,
                state: "running", startedAt: Date.now(), log: ""
            };
            return { ...this.job };
        }
        isBusy() { return this.job?.state === "running"; }
        getJob(owner: number) { return this.jobOwner === owner && this.job ? { ...this.job } : null; }
        cancel(owner: number) {
            cancellations.push({ owner, runner: this });
            if (this.jobOwner === owner && this.job) this.job.state = "cancelled";
        }
        shutdown() {}
    }

    const app = new EventEmitter();
    const fakeProcess = new EventEmitter();
    const module = { exports: {} };
    const dependencies: Record<string, unknown> = {
        "@main/utils/constants": { DATA_DIR: "/synthetic-vencord-data" },
        "./engine": { EngineManager: function () { return engine; } },
        "./runner": {
            ExportRunner: FakeRunner,
            normalizeExportPaths: (options: ExportOptions) => ({ ...options, outputPath: options.outputPath.trim() })
        },
        "electron": {
            app,
            BrowserWindow: { fromWebContents: () => null },
            dialog: {
                async showMessageBox() {
                    hooks.prompts++;
                    return hooks.showMessageBox();
                }
            },
            shell: {}
        },
        "node:fs/promises": { stat: (path: string) => hooks.stat(path) }
    };

    // Execute the real native wrapper, isolating Electron, disk access, processes, and downloads.
    // The fake process emitter keeps each module's exit handler out of the test process.
    runInNewContext(nativeCode, {
        module,
        exports: module.exports,
        process: fakeProcess,
        require(specifier: string) {
            if (specifier in dependencies) return dependencies[specifier];
            if (specifier.startsWith("node:")) return requireBuiltin(specifier);
            throw new Error(`Unmocked native dependency: ${specifier}`);
        }
    }, { filename: "native-under-test.cjs" });

    return {
        api: module.exports as NativeApi,
        a: { sender: new Sender(1) },
        b: { sender: new Sender(2) },
        engine, probes, starts, cancellations, hooks, app
    };
}

function request(): Omit<ExportRequest, "executablePath"> {
    return {
        channelId: "123456789012345678",
        token: "mfa.synthetic-native-wrapper-test-token-never-real",
        options: { ...createDefaultOptions(), outputPath: "/synthetic-exports/chat.html" }
    };
}

test("setup cancelled during cached verification cannot start a late compatibility probe", async () => {
    const h = harness();
    const verification = deferred<string>();
    h.engine.verify = () => verification.promise;
    const checking = h.api.getEngineStatus(h.a);
    await waitFor(() => h.engine.verifyCalls === 1);
    await h.api.cancelEngineSetup(h.a);
    verification.resolve(MANAGED_PATH);
    assert.notEqual((await checking).state, "ready");
    assert.equal(h.probes.length, 0, "cancellation must be checked after the asynchronous file verification");
});

test("setup cancelled while reading cached status cannot start verification afterwards", async () => {
    const h = harness();
    const status = deferred<EngineStatus>();
    let reads = 0;
    h.engine.readStatus = async () => ++reads === 1 ? status.promise : { ...h.engine.status };
    const checking = h.api.getEngineStatus(h.a);
    await waitFor(() => reads === 1);
    await h.api.cancelEngineSetup(h.a);
    status.resolve({ state: "ready", version: "2.48" });
    assert.notEqual((await checking).state, "ready");
    assert.equal(h.engine.verifyCalls, 0);
    assert.equal(h.probes.length, 0);
});

test("a cancelled window's late probe failure cannot poison or clear another window's readiness check", async () => {
    const h = harness();
    const firstProbe = deferred<{ version: string; help: string; }>();
    const secondProbe = deferred<{ version: string; help: string; }>();
    h.hooks.inspect = owner => owner === 1 ? firstProbe.promise : secondProbe.promise;
    const first = h.api.getEngineStatus(h.a);
    await waitFor(() => h.probes.length === 1);
    await h.api.cancelEngineSetup(h.a);
    const second = h.api.getEngineStatus(h.b);
    await waitFor(() => h.probes.length === 2);

    firstProbe.reject(new Error("synthetic cancelled first probe"));
    assert.equal((await first).state, "verifying");
    const whileSecondPending = await h.api.getEngineStatus(h.b);
    assert.equal(whileSecondPending.state, "verifying");
    assert.equal(whileSecondPending.error, undefined);
    assert.equal(h.probes.length, 2, "a stale finally handler must not detach the newer shared check");

    secondProbe.resolve({ version: "2.48", help: "synthetic offline help" });
    assert.equal((await second).state, "ready");
    const ready = await h.api.getEngineStatus(h.b);
    assert.equal(ready.state, "ready");
    assert.equal(ready.error, undefined);
    assert.equal(h.probes.length, 2);
});

test("Cancel setup cannot terminate this window's export or another window's download", async () => {
    const h = harness();
    await h.api.startExport(h.a, request());
    const exportRunner = h.starts[0].runner;
    // Model manager state independently to exercise cancellation ownership at the IPC boundary.
    h.engine.status = { state: "downloading", version: "2.48", progress: 25 };
    h.engine.downloadOwner = h.b.sender.id;

    await assert.rejects(h.api.cancelEngineSetup(h.a), /window that started it/);
    assert.equal((await h.api.getJob(h.a))?.state, "running");
    assert.equal(h.cancellations.some(call => call.runner === exportRunner), false);
    assert.equal(h.engine.downloadOwner, h.b.sender.id);
    assert.equal(h.engine.status.state, "downloading");
});

test("preparing the exporter is blocked while an export verifies its executable, and cancellation releases the reservation", async () => {
    const h = harness();
    const verification = deferred<string>();
    h.engine.verify = () => verification.promise;
    const exporting = h.api.startExport(h.a, request());
    const cancelled = assert.rejects(exporting, /cancelled/);
    await waitFor(() => h.engine.verifyCalls === 1);
    await assert.rejects(h.api.prepareEngine(h.b), /current export/);
    assert.equal(h.engine.prepareCalls.length, 0);

    await h.api.cancelExport(h.a);
    verification.resolve(MANAGED_PATH);
    await cancelled;
    assert.equal(h.starts.length, 0, "cancelled verification must not hand credentials to the runner");
    h.engine.verify = async () => MANAGED_PATH;
    assert.equal((await h.api.prepareEngine(h.b)).state, "ready");
    assert.deepEqual(h.engine.prepareCalls, [h.b.sender.id]);
});

test("preparing the exporter is blocked while replacement confirmation is open, and declining releases the reservation", async () => {
    const h = harness();
    const confirmation = deferred<{ response: number; }>();
    h.hooks.stat = async () => ({ isFile: () => true });
    h.hooks.showMessageBox = () => confirmation.promise;
    const exporting = h.api.startExport(h.a, request());
    const declined = assert.rejects(exporting, /cancelled before replacing/);
    await waitFor(() => h.hooks.prompts === 1);
    await assert.rejects(h.api.prepareEngine(h.b), /current export/);
    assert.equal(h.engine.prepareCalls.length, 0);
    assert.equal(h.engine.verifyCalls, 0);

    confirmation.resolve({ response: 0 });
    await declined;
    assert.equal(h.starts.length, 0);
    assert.equal((await h.api.prepareEngine(h.b)).state, "ready");
});

test("preparing the exporter is blocked for the full lifetime of a running export", async () => {
    const h = harness();
    await h.api.startExport(h.a, request());
    await assert.rejects(h.api.prepareEngine(h.b), /current export/);
    assert.equal(h.engine.prepareCalls.length, 0);
    assert.equal((await h.api.getJob(h.a))?.state, "running");

    await h.api.cancelExport(h.a);
    assert.equal((await h.api.prepareEngine(h.b)).state, "ready");
});

test("a renderer-supplied executable path cannot replace the managed verified executable", async () => {
    const h = harness();
    const injected = { ...request(), executablePath: "/synthetic-untrusted/credential-stealer" };
    await h.api.startExport(h.a, injected);
    assert.equal(h.engine.verifyCalls, 1);
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].request.executablePath, MANAGED_PATH);
    assert.equal(h.starts[0].request.token, injected.token);
    assert.equal(injected.executablePath, "/synthetic-untrusted/credential-stealer", "caller input remains untouched");
});
