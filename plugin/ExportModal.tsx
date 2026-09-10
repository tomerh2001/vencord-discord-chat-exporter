/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, Select, TextInput } from "@webpack/common";

import { Native } from "./bridge";
import type { EngineStatus, JobSnapshot } from "./native";
import { createDefaultOptions, ExportOptions, FORMAT_OPTIONS, THREAD_OPTIONS, validateExportOptions } from "./options";
import { settings } from "./settings";

export interface ExportChannel {
    id: string;
    name: string;
    type: number;
}

interface Props {
    channel: ExportChannel;
    getToken: () => string | null;
    modalProps: RenderModalProps;
}

type BooleanOption = {
    [Key in keyof ExportOptions]: ExportOptions[Key] extends boolean ? Key : never
}[keyof ExportOptions];

// Discord's Select supports string ARIA labels; its upstream declaration currently says boolean.
const LabelledSelect = Select as unknown as React.ComponentType<
    Omit<React.ComponentProps<typeof Select>, "aria-labelledby" | "aria-label"> & { "aria-labelledby": string; }
>;

function Field({ id, title, description, children }: {
    id: string;
    title: string;
    description?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="vc-dce-field">
            <label className="vc-dce-label" id={`${id}-label`} htmlFor={id}>{title}</label>
            {children}
            {description && <p className="vc-dce-hint" id={`${id}-hint`}>{description}</p>}
        </div>
    );
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

const STATUS_LABELS: Record<JobSnapshot["state"], string> = {
    running: "Export in progress",
    completed: "Export complete",
    completedWithWarnings: "Export finished with warnings",
    failed: "Export failed",
    cancelled: "Export cancelled"
};

function ExportModal({ channel, getToken, modalProps }: Props) {
    const isForum = channel.type === 15;
    const [options, setOptions] = React.useState<ExportOptions>(() => {
        const initial = { ...createDefaultOptions(), ...settings.store.exportOptions };
        if (isForum && initial.includeThreads === "None") initial.includeThreads = "Active";
        return initial;
    });
    const [engineStatus, setEngineStatus] = React.useState<EngineStatus | null>(null);
    const [preparing, setPreparing] = React.useState(false);
    const [cancellingSetup, setCancellingSetup] = React.useState(false);
    const [engineError, setEngineError] = React.useState("");
    const [error, setError] = React.useState("");
    const [job, setJob] = React.useState<JobSnapshot | null>(null);
    const [jobReady, setJobReady] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const [cancelling, setCancelling] = React.useState(false);
    const [authSource, setAuthSource] = React.useState<"session" | "supplied">("session");
    const [suppliedToken, setSuppliedToken] = React.useState("");
    const mounted = React.useRef(true);
    const setupPending = React.useRef(false);
    const setupRevision = React.useRef(0);
    const startPending = React.useRef(false);
    const idPrefix = React.useId();

    const running = job?.state === "running";
    const disabled = running || starting;
    const validationErrors = validateExportOptions(options);
    if (isForum && options.includeThreads === "None") {
        validationErrors.push("Choose Active or All threads to export a forum channel.");
    }
    if (authSource === "supplied" && !suppliedToken.trim()) validationErrors.push("Enter the token for the account you want to export with.");
    if (authSource === "supplied" && /\s/.test(suppliedToken.trim())) validationErrors.push("Enter the token by itself, without a Bot or Bearer prefix.");
    const engineReady = engineStatus?.state === "ready";
    const engineBusy = preparing || engineStatus?.state === "downloading" || engineStatus?.state === "verifying";
    const canExport = jobReady && engineReady && !engineBusy && !cancellingSetup && !disabled && validationErrors.length === 0;
    const isOutputDirectory = /[\\/]$/.test(options.outputPath.trim());
    const hasChannelIdTemplate = Array.from(options.outputPath.matchAll(/%./g)).some(([token]) => token === "%c");
    const fieldId = (key: string) => `${idPrefix}-${key}`;

    function update<Key extends keyof ExportOptions>(key: Key, value: ExportOptions[Key]) {
        setOptions(previous => ({ ...previous, [key]: value }));
    }

    async function prepareEngine() {
        if (setupPending.current || engineBusy || disabled) return;
        setupPending.current = true;
        ++setupRevision.current;
        setPreparing(true);
        setEngineError("");
        setEngineStatus(previous => previous && { state: "downloading", version: previous.version });
        try {
            const status = await Native.prepareEngine();
            if (mounted.current) setEngineStatus(status);
        } catch (cause) {
            if (mounted.current) setEngineError(messageOf(cause));
        } finally {
            setupPending.current = false;
            ++setupRevision.current;
            if (mounted.current) setPreparing(false);
        }
    }

    React.useEffect(() => {
        mounted.current = true;
        let timer: ReturnType<typeof setTimeout>;
        let cancelled = false;

        async function poll() {
            const revision = setupRevision.current;
            const [jobResult, engineResult] = await Promise.allSettled([Native.getJob(), Native.getEngineStatus()]);
            if (cancelled) return;
            if (jobResult.status === "fulfilled") {
                setJob(jobResult.value);
                setJobReady(true);
            } else {
                setJobReady(false);
                setError(messageOf(jobResult.reason));
            }
            if (revision === setupRevision.current) {
                if (engineResult.status === "fulfilled") setEngineStatus(engineResult.value);
                else {
                    setEngineStatus(null);
                    setEngineError(messageOf(engineResult.reason));
                }
            }
            timer = setTimeout(poll, 1000);
        }

        void poll();

        return () => {
            cancelled = true;
            mounted.current = false;
            clearTimeout(timer);
        };
    }, []);

    async function cancelEngineSetup() {
        setCancellingSetup(true);
        ++setupRevision.current;
        setEngineError("");
        try {
            await Native.cancelEngineSetup();
            const status = await Native.getEngineStatus();
            if (mounted.current) setEngineStatus(status);
        } catch (cause) {
            if (mounted.current) setEngineError(messageOf(cause));
        } finally {
            ++setupRevision.current;
            if (mounted.current) setCancellingSetup(false);
        }
    }

    async function chooseOutput(directory: boolean) {
        setError("");
        try {
            const path = directory
                ? await Native.selectOutputDirectory()
                : await Native.selectOutputFile(options.outputPath, options.format);
            if (mounted.current && path) update("outputPath", path);
        } catch (cause) {
            if (mounted.current) setError(messageOf(cause));
        }
    }

    async function startExport() {
        if (!canExport || startPending.current) return;
        startPending.current = true;
        setStarting(true);
        setError("");
        try {
            // Read the current account credential only in response to the Export button.
            const token = authSource === "session" ? getToken() : suppliedToken.trim();
            if (!token) throw new Error("Your Discord session is unavailable. Sign in again or supply a token before exporting.");
            const nextJob = await Native.startExport({ channelId: channel.id, options, token });
            // Date boundaries and search terms apply only to this export, never the next chat.
            // A literal filename must be chosen afresh to avoid reusing it for another chat.
            const outputPath = isOutputDirectory || hasChannelIdTemplate ? options.outputPath : "";
            settings.store.exportOptions = { ...options, outputPath, after: "", before: "", filter: "" };
            if (mounted.current) {
                setJob(nextJob);
                setSuppliedToken("");
            }
        } catch (cause) {
            if (mounted.current) setError(messageOf(cause));
        } finally {
            startPending.current = false;
            if (mounted.current) setStarting(false);
        }
    }

    async function cancelExport() {
        setCancelling(true);
        setError("");
        try {
            await Native.cancelExport();
            const snapshot = await Native.getJob();
            if (mounted.current) setJob(snapshot);
        } catch (cause) {
            if (mounted.current) setError(messageOf(cause));
        } finally {
            if (mounted.current) setCancelling(false);
        }
    }

    async function revealOutput() {
        try {
            await Native.revealOutput();
        } catch (cause) {
            if (mounted.current) setError(messageOf(cause));
        }
    }

    function toggle(key: BooleanOption, title: string, description: string, extraDisabled = false) {
        return (
            <FormSwitch
                title={title}
                description={description}
                value={options[key]}
                onChange={value => {
                    if (key === "media" && !value) {
                        setOptions(previous => ({ ...previous, media: false, reuseMedia: false, mediaDir: "" }));
                    } else update(key, value);
                }}
                disabled={disabled || extraDisabled}
                hideBorder
            />
        );
    }

    function textField(key: "after" | "before" | "partition" | "filter" | "mediaDir" | "locale", title: string, placeholder: string, description?: React.ReactNode, extraDisabled = false) {
        const id = fieldId(key);
        return (
            <Field id={id} title={title} description={description}>
                <TextInput
                    id={id}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={description ? `${id}-hint` : undefined}
                    value={options[key]}
                    onChange={value => update(key, value)}
                    placeholder={placeholder}
                    disabled={disabled || extraDisabled}
                    maxLength={null}
                />
            </Field>
        );
    }

    return (
        <Modal
            {...modalProps}
            size="xl"
            title="Export chat"
            subtitle={channel.name}
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                ...(job && !running ? [{ text: "Show exported files", variant: "secondary", onClick: () => void revealOutput() }] : []),
                running
                    ? { text: "Cancel export", variant: "critical-primary", onClick: () => void cancelExport(), loading: cancelling, disabled: cancelling }
                    : { text: "Export chat", variant: "primary", onClick: () => void startExport(), loading: starting, disabled: !canExport }
            ]}
        >
            <div className="vc-dce-modal">
                <div className="vc-dce-notice">
                    <strong>Export with care.</strong> Automating a Discord user account can violate Discord’s rules and put the account at risk. Respecting rate limits reduces request pressure; it does not guarantee account safety.
                    <p className="vc-dce-safety-summary">
                        <strong>Rate-limit safeguards: {options.respectRateLimits ? "on" : "OFF"}</strong>
                        {" · "}Parallel exports: {Number.isFinite(options.parallel) ? options.parallel : "—"}
                        {(!options.respectRateLimits || options.parallel > 1) && " — increased request pressure; review Advanced options."}
                    </p>
                </div>

                <details className="vc-dce-section" open={!engineReady}>
                    <summary>Exporter <span className="vc-dce-summary-note">{engineReady ? `Ready · ${engineStatus.version}` : engineBusy ? "Preparing…" : "One-time setup"}</span></summary>
                    <div className="vc-dce-section-body">
                        <p className="vc-dce-hint">
                            {engineReady
                                ? "The official DiscordChatExporter is installed and verified. "
                                : "Download the official DiscordChatExporter for this computer (about 10–12 MB). The plugin installs and verifies it automatically. This step does not read your Discord credential or chats. "}
                            <Link href="https://github.com/Tyrrrz/DiscordChatExporter/releases/tag/2.48">About DiscordChatExporter 2.48</Link>
                        </p>
                        <div role="status" aria-live="polite">
                            {engineStatus === null && !engineBusy && <p className="vc-dce-hint">Checking exporter…</p>}
                            {engineBusy && <p className="vc-dce-hint">
                                {engineStatus?.state === "verifying" ? "Verifying the download…" : `Downloading from GitHub${engineStatus?.progress === undefined ? "…" : ` · ${Math.round(engineStatus.progress)}%`}`}
                                {" "}You can close this dialog and reopen Export chat to check progress.
                            </p>}
                        </div>
                        {!engineReady && <div className="vc-dce-button-row">
                            {engineBusy
                                ? <Button variant="secondary" size="small" disabled={cancellingSetup} onClick={() => void cancelEngineSetup()}>{cancellingSetup ? "Cancelling…" : "Cancel setup"}</Button>
                                : <Button variant="primary" size="small" disabled={disabled || !engineStatus || cancellingSetup} onClick={() => void prepareEngine()}>{engineStatus?.state === "failed" ? "Retry setup" : "Prepare exporter"}</Button>}
                        </div>}
                        {(engineError || engineStatus?.error) && <p role="alert" className="vc-dce-error">{engineError || engineStatus?.error}</p>}
                    </div>
                </details>

                <section className="vc-dce-section vc-dce-section-open" aria-labelledby={fieldId("destination-heading")}>
                    <Heading tag="h3" className="vc-dce-section-title" id={fieldId("destination-heading")}>Destination</Heading>
                    <Field id={fieldId("outputPath")} title="Output file or folder" description={<>
                        A folder creates filenames automatically. File paths support <Link href="https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/.docs/Using-the-CLI.md#generating-the-filename-and-output-directory-dynamically">naming templates</Link>. Only folders and templates containing %c (channel ID) are remembered. Existing files with the same name may be replaced.
                    </>}>
                        <TextInput
                            id={fieldId("outputPath")}
                            aria-describedby={`${fieldId("outputPath")}-hint`}
                            value={options.outputPath}
                            onChange={value => update("outputPath", value)}
                            placeholder="Choose where to save this export"
                            disabled={disabled}
                            maxLength={null}
                        />
                    </Field>
                    <div className="vc-dce-button-row">
                        <Button variant="secondary" size="small" disabled={disabled} onClick={() => void chooseOutput(true)}>Choose folder…</Button>
                        <Button variant="secondary" size="small" disabled={disabled} onClick={() => void chooseOutput(false)}>Choose file…</Button>
                    </div>
                    {options.includeThreads !== "None" && options.outputPath.trim() && !isOutputDirectory && !hasChannelIdTemplate && <div className="vc-dce-notice" role="status">
                        Different threads can have the same name. Include %c (channel ID) in the filename, or choose a folder, to keep their exports from overwriting each other.
                    </div>}
                    <Field id={fieldId("format")} title="Export format">
                        <LabelledSelect
                            aria-labelledby={`${fieldId("format")}-label`}
                            options={FORMAT_OPTIONS}
                            select={value => update("format", value)}
                            isSelected={value => value === options.format}
                            serialize={String}
                            isDisabled={disabled}
                        />
                    </Field>
                </section>

                <section className="vc-dce-section vc-dce-section-open" aria-labelledby={fieldId("messages-heading")}>
                    <Heading tag="h3" className="vc-dce-section-title" id={fieldId("messages-heading")}>Messages and threads</Heading>
                    <div className="vc-dce-grid">
                        {textField("after", "After", "Date, time, or message ID")}
                        {textField("before", "Before", "Date, time, or message ID")}
                    </div>
                    <p className="vc-dce-hint">Leave both empty for the entire history. Use an ISO date/time (for example, 2026-01-01T00:00:00+03:00) or a Discord message ID. Dates without an offset use your local time.</p>
                    <Field id={fieldId("includeThreads")} title="Include threads" description={isForum
                        ? "Forum posts are threads. Select Active for current posts or All to also discover archived posts."
                        : "Includes child threads when exporting a channel. Selecting a thread directly exports that thread’s messages."}>
                        <LabelledSelect
                            aria-labelledby={`${fieldId("includeThreads")}-label`}
                            options={THREAD_OPTIONS.map(option => ({ ...option, disabled: isForum && option.value === "None" }))}
                            select={value => update("includeThreads", value)}
                            isSelected={value => value === options.includeThreads}
                            serialize={String}
                            isDisabled={disabled}
                        />
                    </Field>
                    {options.includeThreads === "All" && <p className="vc-dce-hint">Discovering archived threads adds API requests and may take longer.</p>}
                    {textField("filter", "Message filter", "Optional DiscordChatExporter filter expression", <>
                        Uses <Link href="https://github.com/Tyrrrz/DiscordChatExporter/blob/2.48/.docs/Message-filters.md">DiscordChatExporter’s filter syntax</Link>. Filtering happens after messages are downloaded and does not reduce requests.
                    </>)}
                </section>

                <details className="vc-dce-section">
                    <summary>Media and attachments <span className="vc-dce-summary-note">{options.media ? "Download enabled" : "Links only"}</span></summary>
                    <div className="vc-dce-section-body">
                        {toggle("media", "Download media", "Save attachments and other media locally so the export does not depend on Discord links remaining available.")}
                        {toggle("reuseMedia", "Reuse downloaded media", "Reuse matching files in the media directory to avoid downloading them again.", !options.media)}
                        {textField("mediaDir", "Media directory", "Default: beside the export", "Optional directory for downloaded media. Supports the exporter’s naming templates.", !options.media)}
                    </div>
                </details>

                <details className="vc-dce-section">
                    <summary>Advanced options <span className="vc-dce-summary-note">Partitions, formatting, and request limits</span></summary>
                    <div className="vc-dce-section-body">
                        {textField("partition", "Split export into parts", "No partitioning", "Optional message count or file size, such as 10000 or 20mb.")}
                        <div className="vc-dce-grid">
                            {textField("locale", "Locale", "System default", "For example, en-US or he-IL. Controls date and number formatting.")}
                            <Field id={fieldId("parallel")} title="Parallel channel exports" description="1 is recommended. Higher values increase concurrent requests when including threads.">
                                <TextInput
                                    id={fieldId("parallel")}
                                    aria-describedby={`${fieldId("parallel")}-hint`}
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={Number.isNaN(options.parallel) ? "" : String(options.parallel)}
                                    onChange={value => update("parallel", value.trim() ? Number(value) : NaN)}
                                    disabled={disabled}
                                />
                            </Field>
                        </div>
                        {toggle("respectRateLimits", "Respect Discord’s advisory rate limits", "Recommended. Keeps the exporter’s additional rate-limit safeguards enabled.")}
                        {(!options.respectRateLimits || options.parallel > 1) && <div className="vc-dce-notice vc-dce-warning" role="status">
                            {!options.respectRateLimits && "Advisory rate-limit safeguards are disabled. "}
                            {options.parallel > 1 && "Multiple channels may be exported at once. "}
                            These settings increase request pressure and account risk.
                        </div>}
                        {toggle("reverse", "Newest messages first", "Export messages in reverse chronological order.")}
                        {toggle("markdown", "Render Markdown", "Process Markdown, mentions, and other special tokens in supported export formats.")}
                        {toggle("utc", "Use UTC timestamps", "Display timestamps in UTC instead of your local time zone.")}
                        {toggle("suppressUkraineMessage", "Hide the exporter’s Ukraine message", "Suppress the optional informational message in the exporter’s output.")}
                        <Button
                            variant="secondary"
                            size="small"
                            disabled={disabled}
                            onClick={() => setOptions({ ...createDefaultOptions(), outputPath: options.outputPath, includeThreads: isForum ? "Active" : "None" })}
                        >Reset options to recommended defaults</Button>
                    </div>
                </details>

                <details className="vc-dce-section">
                    <summary>Account <span className="vc-dce-summary-note">{authSource === "session" ? "Signed-in Discord account" : "Supplied token"}</span></summary>
                    <div className="vc-dce-section-body">
                        <Field id={fieldId("authSource")} title="Export using">
                            <LabelledSelect
                                aria-labelledby={`${fieldId("authSource")}-label`}
                                options={[
                                    { label: "Signed-in Discord account", value: "session" },
                                    { label: "Supply a bot or user token", value: "supplied" }
                                ]}
                                select={value => {
                                    setAuthSource(value);
                                    setSuppliedToken("");
                                }}
                                isSelected={value => value === authSource}
                                serialize={String}
                                isDisabled={disabled}
                            />
                        </Field>
                        {authSource === "supplied" ? <Field id={fieldId("token")} title="Bot or user token" description="Paste the token only, without a Bot prefix. The exporter detects the account type. A bot must have access to the selected server channel and cannot export your private DMs. This token is cleared after starting and never saved.">
                            <TextInput
                                id={fieldId("token")}
                                aria-describedby={`${fieldId("token")}-hint`}
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                value={suppliedToken}
                                onChange={setSuppliedToken}
                                disabled={disabled}
                                maxLength={null}
                            />
                        </Field> : <p className="vc-dce-hint">Uses the account currently signed in to Discord. You do not need to find or copy its token.</p>}
                    </div>
                </details>

                {validationErrors.length > 0 && !running && <div className="vc-dce-validation" role="status">
                    <strong>Before exporting</strong>
                    <ul>{validationErrors.map(message => <li key={message}>{message}</li>)}</ul>
                </div>}
                {error && <div className="vc-dce-notice vc-dce-error" role="alert">{error}</div>}

                {job && <section className="vc-dce-job" aria-label="Current or most recent export">
                    <div className="vc-dce-job-header" role="status" aria-live="polite">
                        <span className={`vc-dce-status-dot vc-dce-status-${job.state}`} />
                        <strong>{STATUS_LABELS[job.state]}{job.channelId !== channel.id ? " · another chat" : ""}</strong>
                    </div>
                    <p className="vc-dce-path">{job.outputPath}</p>
                    {running && <p className="vc-dce-hint">You can close this dialog and reopen Export chat to check progress. The export continues while Discord stays open.</p>}
                    {job.state === "completedWithWarnings" && <p className="vc-dce-hint">Some data may be missing. Review the exporter’s log below before relying on this export.</p>}
                    {(job.state === "cancelled" || job.state === "failed") && <p className="vc-dce-hint">Any files already written may be incomplete.</p>}
                    <details className="vc-dce-log-details" open={job.state === "failed" || job.state === "completedWithWarnings"}>
                        <summary>Exporter log</summary>
                        <pre className="vc-dce-log" tabIndex={0} aria-label="Exporter log">{job.log || "Waiting for exporter output…"}</pre>
                    </details>
                </section>}

                <p className="vc-dce-hint vc-dce-footnote">Your account credential is used only when you click Export chat and is never saved by this plugin. Export preferences are remembered; dates, message filters, and tokens are not.</p>
            </div>
        </Modal>
    );
}

export function openExportModal(channel: ExportChannel, getToken: () => string | null) {
    return openModal(modalProps => <ExportModal channel={channel} getToken={getToken} modalProps={modalProps} />,
        { modalKey: "vc-discord-chat-exporter" });
}
