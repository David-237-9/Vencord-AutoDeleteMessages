import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, Constants, RestAPI, UserStore } from "@webpack/common";

import Settings, { MAX_SECONDS } from "./settings";

const Native = VencordNative.pluginHelpers.AutoDeleteMessages as PluginNative<typeof import("./native")> | undefined;

type Location = "dm" | "groupDm" | "guild";
type Reason = "timer" | "close";

interface MessageCreateEvent {
    optimistic?: boolean;
    channelId?: string;
    message?: {
        id?: string;
        channel_id?: string;
        type?: number;
        author?: { id?: string; };
    };
}

interface StoredMessage {
    id: string;
    channelId: string;
    userId: string;
    location: Location;
    dueAt: number | null;
}

interface PendingMessage extends StoredMessage {
    timer?: ReturnType<typeof setTimeout>;
}

interface DeletionTask {
    entry: PendingMessage;
    reason: Reason;
    generation: number;
    failures: number;
    readyAt: number;
    done: Promise<void>;
    resolve(): void;
}

const logger = new Logger("AutoDeleteMessages");
const pending = new Map<string, PendingMessage>();
const jobs = new Map<string, DeletionTask>();
const channels = new Map<string, DeletionTask[]>();
const busyChannels = new Set<string>();
const channelCooldowns = new Map<string, number>();
const incoming = new Set<Promise<void>>();
const UNDELETABLE_TYPES = new Set([1, 2, 3, 4, 5, 21]);

const STORAGE_PREFIX = "Vencord:AutoDeleteMessages:pending:";
const WORKERS = 3;
const RETRY_LATER_MS = 30_000;

let storageTail = Promise.resolve();
let restoreTail = Promise.resolve();
let activeUserId: string | undefined;
let unauthorizedUserId: string | undefined;
let globalCooldownUntil = 0;
let queueWakeup: ReturnType<typeof setTimeout> | undefined;
let queueWakeAt = 0;
let generation = 0;
let closing = false;
let running = false;

function delayFor(location: Location): number {
    const seconds = location === "dm" ? Settings.store.dmSeconds
        : location === "groupDm" ? Settings.store.groupDmSeconds
            : Settings.store.guildSeconds;

    return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS
        ? seconds : 0;
}

function deleteOnClose(location: Location): boolean {
    return location === "dm" ? Settings.store.dmOnClose
        : location === "groupDm" ? Settings.store.groupDmOnClose
            : Settings.store.guildOnClose;
}

function isStoredMessage(value: unknown, userId: string): value is StoredMessage {
    if (!value || typeof value !== "object") return false;

    const item = value as Partial<StoredMessage>;
    return typeof item.id === "string" && /^\d{17,20}$/.test(item.id)
        && typeof item.channelId === "string" && /^\d{17,20}$/.test(item.channelId)
        && item.userId === userId
        && (item.location === "dm" || item.location === "groupDm" || item.location === "guild")
        && (item.dueAt === null || (typeof item.dueAt === "number" && Number.isFinite(item.dueAt)));
}

function storedEntries(value: unknown, userId: string): StoredMessage[] {
    return Array.isArray(value)
        ? value.filter(item => isStoredMessage(item, userId))
        : [];
}

function toStored({ id, channelId, userId, location, dueAt }: StoredMessage): StoredMessage {
    return { id, channelId, userId, location, dueAt };
}

function updateStored(
    userId: string,
    update: (entries: StoredMessage[]) => StoredMessage[]
): Promise<void> {
    // Atomic updates prevent simultaneous workers from losing queue entries.
    // Serialization provides a shutdown barrier for pending writes.
    storageTail = storageTail.then(async () => {
        await DataStore.update<unknown>(
            STORAGE_PREFIX + userId,
            value => update(storedEntries(value, userId))
        );
    }).catch(error => logger.error(
        "Could not save the pending queue; restart recovery is unavailable until storage works",
        error
    ));

    return storageTail;
}

function saveEntry(entry: StoredMessage): Promise<void> {
    const saved = toStored(entry);
    return updateStored(
        entry.userId,
        entries => [...entries.filter(item => item.id !== saved.id), saved]
    );
}

function persistPending(): Promise<void> {
    const accounts = new Map<string, StoredMessage[]>();

    for (const entry of pending.values()) {
        const entries = accounts.get(entry.userId) ?? [];
        entries.push(toStored(entry));
        accounts.set(entry.userId, entries);
    }

    for (const [userId, entries] of accounts) {
        const ids = new Set(entries.map(entry => entry.id));
        void updateStored(
            userId,
            saved => [...saved.filter(entry => !ids.has(entry.id)), ...entries]
        );
    }

    return storageTail;
}

function clearTimer(entry: PendingMessage) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
}

function forget(entry: PendingMessage): Promise<void> {
    clearTimer(entry);
    if (pending.get(entry.id) === entry) pending.delete(entry.id);
    pump();

    return updateStored(
        entry.userId,
        entries => entries.filter(item => item.id !== entry.id)
    );
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? value as Record<string, unknown> : {};
}

function header(headers: unknown, name: string): string | undefined {
    const values = asObject(headers);

    if (typeof values.get === "function") {
        const value: unknown = values.get.call(headers, name);
        return value == null ? undefined : String(value);
    }

    const key = Object.keys(values).find(
        key => key.toLowerCase() === name.toLowerCase()
    );

    return key === undefined || values[key] == null
        ? undefined : String(values[key]);
}

function secondsToMs(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") return;
    if (value === "") return;

    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000 : undefined;
}

function responseInfo(value: unknown) {
    const outer = asObject(value);
    const inner = asObject(outer.response);
    let body = asObject(outer.body ?? inner.body ?? outer.data ?? inner.data);
    const text = outer.text ?? inner.text;

    if (Object.keys(body).length === 0 && typeof text === "string") {
        try {
            body = asObject(JSON.parse(text));
        } catch {
            // A non-JSON error has no Discord response fields.
        }
    }

    const headers = outer.headers ?? inner.headers;
    const rawStatus = outer.status ?? outer.statusCode ?? inner.status ?? inner.statusCode;
    const status = typeof rawStatus === "number" && rawStatus >= 100
        ? rawStatus : undefined;

    const retryHeader = header(headers, "retry-after");
    const retryAfterMs = secondsToMs(body.retry_after)
        ?? secondsToMs(retryHeader)
        ?? (retryHeader && Number.isFinite(Date.parse(retryHeader))
            ? Math.max(0, Date.parse(retryHeader) - Date.now())
            : undefined);

    return {
        status,
        code: typeof body.code === "number" ? body.code : undefined,
        headers,
        // Discord can return body/headers without a top-level status field.
        rateLimited: status === 429
            || (status === undefined && retryAfterMs !== undefined),
        retryAfterMs,
        global: body.global === true
            || header(headers, "x-ratelimit-global") === "true"
            || header(headers, "x-ratelimit-scope") === "global",
        failed: outer.ok === false || (status !== undefined && status >= 400)
    };
}

function channelKey(entry: StoredMessage): string {
    return entry.userId + ":" + entry.channelId;
}

function applyCooldown(entry: StoredMessage, ms: number, global: boolean) {
    const until = Date.now() + ms + 50;

    if (global) {
        globalCooldownUntil = Math.max(globalCooldownUntil, until);
    } else {
        const key = channelKey(entry);
        channelCooldowns.set(key, Math.max(channelCooldowns.get(key) ?? 0, until));
    }
}

function learnRateLimit(entry: StoredMessage, headers: unknown) {
    if (header(headers, "x-ratelimit-remaining") !== "0") return;

    const reset = secondsToMs(header(headers, "x-ratelimit-reset-after"));
    if (reset !== undefined) applyCooldown(entry, reset, false);
}

function canRun(task: DeletionTask): boolean {
    return running
        && task.generation === generation
        && pending.get(task.entry.id) === task.entry
        && UserStore.getCurrentUser()?.id === task.entry.userId
        && unauthorizedUserId !== task.entry.userId;
}

async function deleteTask(task: DeletionTask): Promise<boolean> {
    const { entry } = task;
    if (!canRun(task)) return true;
    if (task.reason === "close" && !deleteOnClose(entry.location)) return true;
    if (task.reason === "timer" && delayFor(entry.location) === 0) {
        if (!deleteOnClose(entry.location)) await forget(entry);
        return true;
    }

    try {
        const response: unknown = await RestAPI.del({
            url: Constants.Endpoints.MESSAGE(entry.channelId, entry.id)
        });

        const info = responseInfo(response);
        if (info.failed || info.rateLimited) throw response;

        learnRateLimit(entry, info.headers);
        await forget(entry);
        return true;
    } catch (error) {
        const info = responseInfo(error);
        if (info.code === 10008 || (info.status === 404 && info.code === undefined)) {
            await forget(entry);
            return true;
        }
        if (info.code === 50021) {
            // Old queues can contain call/channel-change/thread-starter messages.
            // Discord cannot delete these; do not retry them on every launch.
            logger.info(`Skipped non-deletable system message ${entry.id}`);
            await forget(entry);
            return true;
        }
        if (info.rateLimited) {
            applyCooldown(entry, info.retryAfterMs ?? 1000, info.global);
            return false;
        }

        if (info.status === 401) unauthorizedUserId = entry.userId;
        const retryable = info.status === undefined || info.status === 408 || info.status >= 500;
        task.failures++;
        if (!retryable || task.failures >= 3) {
            logger.warn(`Deletion left pending for message ${entry.id} (status ${info.status ?? "network error"}, code ${info.code ?? "unknown"})`);
            if (retryable && canRun(task) && !closing) {
                schedule(entry, RETRY_LATER_MS, task.reason);
            }
            return true;
        }
        task.readyAt = Date.now() + 1000 * task.failures;
        return false;
    }
}

function finishTask(task: DeletionTask) {
    if (jobs.get(task.entry.id) === task) jobs.delete(task.entry.id);
    task.resolve();
}

function clearQueueWakeup() {
    if (queueWakeup !== undefined) clearTimeout(queueWakeup);
    queueWakeup = undefined;
    queueWakeAt = 0;
}

function wakeQueueAt(at: number) {
    if (queueWakeup !== undefined && queueWakeAt <= at) return;
    clearQueueWakeup();
    queueWakeAt = at;
    queueWakeup = setTimeout(() => {
        queueWakeup = undefined;
        queueWakeAt = 0;
        pump();
    }, Math.min(Math.max(1, at - Date.now()), MAX_SECONDS * 1000));
}

function pump() {
    const now = Date.now();
    let nextWake = Infinity;
    for (const [key, tasks] of [...channels]) {
        if (busyChannels.has(key)) continue;
        while (tasks.length > 0 && !canRun(tasks[0])) finishTask(tasks.shift()!);
        if (tasks.length === 0) {
            channels.delete(key);
            continue;
        }
        const readyAt = Math.max(tasks[0].readyAt, globalCooldownUntil, channelCooldowns.get(key) ?? 0);
        if (readyAt > now) {
            nextWake = Math.min(nextWake, readyAt);
            continue;
        }
        if (busyChannels.size >= WORKERS) continue;

        // One request per turn. Cooldowns never occupy a worker, and a channel
        // moves to the end after its attempt so other ready channels can run.
        const task = tasks.shift()!;
        busyChannels.add(key);
        void (async () => {
            let complete = true;
            try { complete = await deleteTask(task); }
            catch (error) {
                logger.error("Could not process a deletion; its queue entry was retained", error);
            } finally {
                if (complete) finishTask(task);
                else tasks.unshift(task);
                channels.delete(key);
                if (tasks.length > 0) channels.set(key, tasks);
                busyChannels.delete(key);
                pump();
            }
        })();
    }
    if (Number.isFinite(nextWake)) wakeQueueAt(nextWake);
    else clearQueueWakeup();
}

function enqueue(entry: PendingMessage, reason: Reason): Promise<void> {
    clearTimer(entry);
    const existing = jobs.get(entry.id);

    if (existing) {
        if (existing.entry !== entry || existing.generation !== generation) {
            return existing.done.then(() => {
                if (running && pending.get(entry.id) === entry) {
                    return enqueue(entry, reason);
                }
            });
        }

        if (reason === "close") existing.reason = "close";
        return existing.done;
    }

    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const task: DeletionTask = { entry, reason, generation, failures: 0, readyAt: 0, done, resolve };

    jobs.set(entry.id, task);

    const key = channelKey(entry);
    const tasks = channels.get(key) ?? [];
    tasks.push(task);
    channels.set(key, tasks);
    pump();

    return done;
}

function schedule(entry: PendingMessage, retryInMs?: number, reason: Reason = "timer") {
    clearTimer(entry);

    if (!running || closing || pending.get(entry.id) !== entry) return;
    if (entry.dueAt === null && retryInMs === undefined) return;

    const remaining = retryInMs ?? Math.max(0, entry.dueAt! - Date.now());

    entry.timer = setTimeout(() => {
        entry.timer = undefined;

        if (!running || closing || pending.get(entry.id) !== entry) return;

        if (retryInMs === undefined && entry.dueAt !== null && entry.dueAt > Date.now()) {
            schedule(entry);
        } else {
            void enqueue(entry, reason);
        }
    }, Math.min(remaining, MAX_SECONDS * 1000));
}

function restoreForCurrentUser(): Promise<void> {
    const currentGeneration = generation;

    restoreTail = restoreTail.then(async () => {
        if (!running || currentGeneration !== generation) return;

        const userId = UserStore.getCurrentUser()?.id;
        if (userId === activeUserId) return;

        for (const entry of pending.values()) clearTimer(entry);
        pending.clear();
        activeUserId = undefined;

        if (!userId) return;

        await storageTail;
        const value = await DataStore.get<unknown>(STORAGE_PREFIX + userId);

        if (!running || currentGeneration !== generation
            || UserStore.getCurrentUser()?.id !== userId) return;

        activeUserId = userId;

        for (const saved of storedEntries(value, userId)) {
            const entry: PendingMessage = toStored(saved);

            if (delayFor(entry.location) === 0 && !deleteOnClose(entry.location)) {
                void updateStored(
                    userId,
                    entries => entries.filter(item => item.id !== entry.id)
                );
                continue;
            }

            pending.set(entry.id, entry);

            if (deleteOnClose(entry.location)) {
                void enqueue(entry, "close");
            } else {
                schedule(entry);
            }
        }
    }).catch(error => logger.error("Could not restore the pending queue", error));

    return restoreTail;
}

function onConnectionOpen() {
    unauthorizedUserId = undefined;

    void restoreForCurrentUser().then(() => {
        for (const entry of pending.values()) {
            if (!jobs.has(entry.id)) schedule(entry);
        }
    });
}

async function trackMessage({ message, channelId, optimistic }: MessageCreateEvent) {
    if (!running || optimistic || !message) return;

    const currentGeneration = generation;
    await restoreForCurrentUser();

    if (!running || currentGeneration !== generation) return;

    const userId = UserStore.getCurrentUser()?.id;
    const messageId = message.id;
    const targetChannelId = message.channel_id ?? channelId;

    if (!userId || message.author?.id !== userId || !messageId || !targetChannelId) return;
    if (message.type !== undefined && UNDELETABLE_TYPES.has(message.type)) return;
    if (!/^\d{17,20}$/.test(messageId)
        || !/^\d{17,20}$/.test(targetChannelId)
        || pending.has(messageId)) return;

    const channel = ChannelStore.getChannel(targetChannelId);
    if (!channel) return;

    const location: Location | undefined = channel.isDM() ? "dm"
        : channel.isGroupDM() ? "groupDm"
            : channel.guild_id ? "guild" : undefined;

    if (!location) return;

    const seconds = delayFor(location);
    if (seconds === 0 && !deleteOnClose(location)) return;

    const entry: PendingMessage = {
        id: messageId,
        channelId: targetChannelId,
        userId,
        location,
        dueAt: seconds > 0 ? Date.now() + seconds * 1000 : null
    };

    pending.set(messageId, entry);
    await saveEntry(entry);
    schedule(entry);
}

function onMessageCreate(event: MessageCreateEvent) {
    const task = trackMessage(event).catch(
        error => logger.error("Could not track a new message", error)
    );

    incoming.add(task);
    void task.then(() => incoming.delete(task));
}

async function flushOnClose() {
    closing = true;
    for (const entry of pending.values()) clearTimer(entry);

    await restoreForCurrentUser();
    const attempted = new Set<PendingMessage>();

    do {
        await Promise.all([...incoming]);
        await persistPending();

        const entries = [...pending.values()].filter(
            entry => deleteOnClose(entry.location) && !attempted.has(entry)
        );

        for (const entry of entries) attempted.add(entry);
        await Promise.all(entries.map(entry => enqueue(entry, "close")));

        // Include timer/recovery work already occupying a worker.
        await Promise.all([...jobs.values()].map(task => task.done));
    } while (
        running && (
            incoming.size > 0
            || [...pending.values()].some(
                entry => deleteOnClose(entry.location) && !attempted.has(entry)
            )
        )
        );

    await storageTail;

    const remaining = [...pending.values()].filter(
        entry => deleteOnClose(entry.location)
    ).length;

    if (remaining) {
        logger.warn(
            `${remaining} close-time deletion(s) are still stored for recovery on the next launch`
        );
    }
}

async function watchDesktopClose(currentGeneration: number) {
    const native = Native;
    if (!native?.watchForClose) return;

    while (running && currentGeneration === generation) {
        let requested = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let stillOpen = false;

        try {
            requested = await native.watchForClose();

            if (!requested || !running || currentGeneration !== generation) return;

            heartbeat = setInterval(() => {
                void native.keepWaiting().catch(
                    error => logger.error("Could not extend the close window", error)
                );
            }, 15_000);

            await flushOnClose();
        } catch (error) {
            logger.error(
                "Could not process the client close; saved entries will be recovered",
                error
            );
            return;
        } finally {
            if (heartbeat !== undefined) clearInterval(heartbeat);

            if (requested) {
                try {
                    stillOpen = await native.finishClose() === true;
                } catch (error) {
                    logger.error("Could not finish closing the client", error);
                }
            }
        }

        if (!stillOpen) return;

        // Discord may hide the window to the tray.
        closing = false;
        for (const entry of pending.values()) schedule(entry);
    }
}

function onClientUnload() {
    if (closing || !running) return;

    closing = true;
    for (const entry of pending.values()) clearTimer(entry);
    void persistPending();

    // Browser unloads cannot wait. Stored entries survive interrupted requests.
    for (const entry of pending.values()) {
        if (deleteOnClose(entry.location)) void enqueue(entry, "close");
    }
}

export default definePlugin({
    name: "AutoDeleteMessages",
    description: "Deletes your new messages after a delay or when the client closes, with separate controls for DMs, group DMs, and servers.",
    authors: [{ name: "Legend", id: 1n }],
    settings: Settings,

    start() {
        running = true;
        closing = false;
        generation++;

        window.addEventListener("beforeunload", onClientUnload);
        window.addEventListener("pagehide", onClientUnload);

        void restoreForCurrentUser();
        void watchDesktopClose(generation);
    },

    flux: {
        CONNECTION_OPEN: onConnectionOpen,
        MESSAGE_CREATE: onMessageCreate,

        MESSAGE_DELETE({ id }: { id: string; }) {
            const entry = pending.get(id);
            if (entry) void forget(entry);
        },

        MESSAGE_DELETE_BULK({ ids }: { ids: string[]; }) {
            for (const id of ids ?? []) {
                const entry = pending.get(id);
                if (entry) void forget(entry);
            }
        }
    },

    stop() {
        running = false;
        generation++;

        if (Native?.cancelCloseWatcher) {
            void Native.cancelCloseWatcher().catch(
                error => logger.error("Could not cancel the close watcher", error)
            );
        }

        window.removeEventListener("beforeunload", onClientUnload);
        window.removeEventListener("pagehide", onClientUnload);

        for (const entry of pending.values()) clearTimer(entry);

        clearQueueWakeup();
        pending.clear();
        activeUserId = undefined;
        unauthorizedUserId = undefined;
        pump();
    }
});
