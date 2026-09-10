/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { stat } from "node:fs/promises";
import { dirname, extname, join, sep } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, shell } from "electron";

import { EngineManager, EngineStatus } from "./engine";
import { ExportFormat } from "./options";
import { ExportRequest, ExportRunner, normalizeExportPaths } from "./runner";

export type { EngineStatus } from "./engine";
export type { ExporterInfo, ExportRequest, JobSnapshot, JobState } from "./runner";

const runner = new ExportRunner();
const inspector = new ExportRunner();
const engine = new EngineManager({ root: join(DATA_DIR, "DiscordChatExporter") });
const registered = new WeakSet<Electron.WebContents>();
const generations = new WeakMap<Electron.WebContents, number>();
const setupGenerations = new WeakMap<Electron.WebContents, number>();
const setupCancelled = Symbol("Exporter setup was cancelled");
let engineCheck: { owner: number; promise: Promise<void>; } | null = null;
let engineChecked = false;
let engineError = "";
let preparingOwner: number | null = null;
let pendingExports = 0;
let stopping = false;

function invalidateExport(sender: Electron.WebContents): void {
    generations.set(sender, (generations.get(sender) ?? 0) + 1);
    runner.cancel(sender.id);
}

function invalidateSetup(sender: Electron.WebContents): boolean {
    setupGenerations.set(sender, (setupGenerations.get(sender) ?? 0) + 1);
    const cancelledDownload = engine.cancel(sender.id);
    const cancelledCheck = engineCheck?.owner === sender.id;
    if (cancelledCheck) {
        engineCheck = null;
        engineChecked = false;
        engineError = "";
    }
    inspector.cancel(sender.id);
    return cancelledDownload || cancelledCheck || preparingOwner === sender.id;
}

function invalidate(sender: Electron.WebContents): void {
    invalidateExport(sender);
    invalidateSetup(sender);
}

function owner(event: IpcMainInvokeEvent): number {
    const { sender } = event;
    if (!registered.has(sender)) {
        registered.add(sender);
        sender.once("destroyed", () => invalidate(sender));
        sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) invalidate(sender);
        });
        sender.on("render-process-gone", () => invalidate(sender));
    }
    return sender.id;
}

function shutdown() {
    stopping = true;
    engine.shutdown();
    inspector.shutdown();
    runner.shutdown();
}

app.on("before-quit", shutdown);
process.once("exit", shutdown);

async function checkManagedEngine(sender: Electron.WebContents) {
    if (engineChecked) return;
    if (!engineCheck) {
        const generation = setupGenerations.get(sender);
        const check = { owner: sender.id, promise: undefined! as Promise<void> };
        const current = () => engineCheck === check && !stopping && !sender.isDestroyed()
            && generation === setupGenerations.get(sender);
        check.promise = Promise.resolve().then(async () => {
            try {
                if (!current()) throw setupCancelled;
                const executablePath = await engine.getVerifiedExecutable();
                if (!current()) throw setupCancelled;
                await inspector.checkExporter(sender.id, executablePath);
                if (!current()) throw setupCancelled;
                engineChecked = true;
                engineError = "";
            } catch (error) {
                if (!current()) throw setupCancelled;
                engineError = error instanceof Error ? error.message : "The installed exporter could not be checked.";
                throw new Error(engineError);
            }
        }).finally(() => {
            if (engineCheck === check) engineCheck = null;
        });
        engineCheck = check;
    }
    await engineCheck.promise;
}

export async function getEngineStatus(event: IpcMainInvokeEvent): Promise<EngineStatus> {
    owner(event);
    const generation = setupGenerations.get(event.sender);
    const status = await engine.getStatus();
    if (stopping || event.sender.isDestroyed() || generation !== setupGenerations.get(event.sender))
        return { ...status, state: engineCheck ? "verifying" : status.state === "ready" ? "missing" : status.state };
    if (engineError) return { ...status, state: "failed", error: engineError };
    if (engineCheck || (preparingOwner !== null && status.state === "ready")) return { ...status, state: "verifying" };
    if (status.state === "ready" && !engineChecked) {
        try {
            await checkManagedEngine(event.sender);
        } catch (error) {
            const latest = await engine.getStatus();
            if (error === setupCancelled)
                return { ...latest, state: engineCheck ? "verifying" : latest.state === "ready" ? "missing" : latest.state };
            return { ...latest, state: "failed", error: engineError || "The installed exporter could not be checked." };
        }
    }
    return engine.getStatus();
}

export async function prepareEngine(event: IpcMainInvokeEvent): Promise<EngineStatus> {
    const senderId = owner(event);
    const generation = setupGenerations.get(event.sender);
    if (pendingExports > 0 || runner.isBusy()) throw new Error("Wait for the current export to finish or cancel it before preparing the exporter.");
    if (preparingOwner !== null || engineCheck) throw new Error("Exporter setup is already in progress. Wait for it to finish or cancel setup first.");
    preparingOwner = senderId;
    engineError = "";
    engineChecked = false;
    try {
        const status = await engine.prepare(senderId);
        if (stopping || event.sender.isDestroyed() || generation !== setupGenerations.get(event.sender)) throw setupCancelled;
        await checkManagedEngine(event.sender);
        if (stopping || event.sender.isDestroyed() || generation !== setupGenerations.get(event.sender)) throw setupCancelled;
        return status;
    } catch (error) {
        if (error === setupCancelled) throw new Error("Exporter setup was cancelled.");
        throw error;
    } finally {
        preparingOwner = null;
    }
}

export async function cancelEngineSetup(event: IpcMainInvokeEvent): Promise<void> {
    owner(event);
    const cancelled = invalidateSetup(event.sender);
    if (!cancelled) {
        const status = await engine.getStatus();
        if (engineCheck || preparingOwner !== null || status.state === "downloading" || status.state === "verifying")
            throw new Error("Cancel setup in the Discord window that started it.");
    }
}

export async function selectOutputDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
    owner(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { title: "Choose export folder", properties: ["openDirectory", "createDirectory"] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? null : result.filePaths[0];
    return path ? path.replace(/[\\/]+$/, "") + sep : null;
}

export async function selectOutputFile(event: IpcMainInvokeEvent, defaultPath: string, format: ExportFormat): Promise<string | null> {
    owner(event);
    const extensions: Record<ExportFormat, string> = { HtmlDark: "html", HtmlLight: "html", PlainText: "txt", Csv: "csv", Json: "json" };
    const extension = extensions[format];
    if (!extension || typeof defaultPath !== "string") throw new Error("Choose a supported export format.");
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
        title: "Save chat export",
        defaultPath: defaultPath || `chat-export.${extension}`,
        filters: [{ name: `${extension.toUpperCase()} export`, extensions: [extension] }],
        properties: ["createDirectory", "showOverwriteConfirmation"]
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return extname(result.filePath) ? result.filePath : `${result.filePath}.${extension}`;
}

export async function startExport(event: IpcMainInvokeEvent, request: Omit<ExportRequest, "executablePath">) {
    pendingExports++;
    try {
        const senderId = owner(event);
        const generation = generations.get(event.sender);
        const normalizedRequest = { ...request, options: normalizeExportPaths(request?.options) };
        const { outputPath } = normalizedRequest.options;
        if (!outputPath.includes("%") && (await stat(outputPath).catch(() => null))?.isFile()) {
            const parent = BrowserWindow.fromWebContents(event.sender);
            const options: Electron.MessageBoxOptions = {
                type: "warning",
                title: "Replace existing chat export?",
                message: "An export file already exists at the selected path.",
                detail: outputPath,
                buttons: ["Cancel", "Replace file"],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            };
            const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
            if (result.response !== 1) throw new Error("Export cancelled before replacing the existing file.");
        }
        if (stopping || event.sender.isDestroyed() || generation !== generations.get(event.sender))
            throw new Error("The exporter operation was cancelled.");
        // The renderer cannot choose executable paths. Recheck cached bytes before credentials reach a child.
        const executablePath = await engine.getVerifiedExecutable();
        if (stopping || event.sender.isDestroyed() || generation !== generations.get(event.sender))
            throw new Error("The exporter operation was cancelled.");
        return await runner.start(senderId, { ...normalizedRequest, executablePath });
    } finally {
        pendingExports--;
    }
}

export async function getJob(event: IpcMainInvokeEvent) {
    return runner.getJob(owner(event));
}

export async function cancelExport(event: IpcMainInvokeEvent): Promise<void> {
    owner(event);
    invalidateExport(event.sender);
}

export async function cleanup(event: IpcMainInvokeEvent): Promise<void> {
    owner(event);
    invalidate(event.sender);
}

export async function revealOutput(event: IpcMainInvokeEvent): Promise<void> {
    const job = runner.getJob(owner(event));
    if (!job) throw new Error("There is no export output to show.");
    const templateIndex = job.outputPath.indexOf("%");
    let path = templateIndex < 0 ? job.outputPath : dirname(job.outputPath.slice(0, templateIndex) + "template");
    for (;;) {
        const info = await stat(path).catch(() => null);
        if (info) {
            if (info.isDirectory()) {
                const error = await shell.openPath(path);
                if (error) throw new Error("The export folder could not be opened.");
            } else {
                shell.showItemInFolder(path);
            }
            return;
        }
        const parent = dirname(path);
        if (parent === path) throw new Error("The export output folder does not exist.");
        path = parent;
    }
}
