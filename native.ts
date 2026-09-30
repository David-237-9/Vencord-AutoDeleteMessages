import { app, BrowserWindow, IpcMainInvokeEvent } from "electron";

type CloseKind = "window" | "quit";
type ClosableEvent = { preventDefault(): void; };

interface Watcher {
    window: BrowserWindow;
    sender: IpcMainInvokeEvent["sender"];
    resolve: (closing: boolean) => void;
    requested: boolean;
    kind: CloseKind;
    watchdog?: ReturnType<typeof setTimeout>;
    backgroundThrottling?: boolean;
    onWindowClose: (event: ClosableEvent) => void;
    onBeforeQuit: (event: ClosableEvent) => void;
    onDestroyed: () => void;
    onNavigation: (
        event: unknown,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
    ) => void;
}

const WATCHDOG_MS = 60_000;
const watchers = new Map<number, Watcher>();

function cleanup(watcher: Watcher) {
    if (watchers.get(watcher.sender.id) !== watcher) return;

    watchers.delete(watcher.sender.id);
    if (watcher.watchdog !== undefined) clearTimeout(watcher.watchdog);

    watcher.window.off("close", watcher.onWindowClose);
    app.off("before-quit", watcher.onBeforeQuit);
    watcher.sender.off("destroyed", watcher.onDestroyed);
    watcher.sender.off("did-start-navigation", watcher.onNavigation);

    if (!watcher.sender.isDestroyed() && watcher.backgroundThrottling !== undefined) {
        watcher.sender.setBackgroundThrottling(watcher.backgroundThrottling);
    }

    if (!watcher.requested) watcher.resolve(false);
}

function resume(watcher: Watcher): Promise<boolean> {
    const { kind, window, sender } = watcher;
    cleanup(watcher);

    return new Promise(resolve => setImmediate(() => {
        if (kind === "quit") {
            app.quit();
            resolve(false);
        } else {
            if (!window.isDestroyed()) window.close();
            resolve(!window.isDestroyed() && !sender.isDestroyed());
        }
    }));
}

function armWatchdog(watcher: Watcher) {
    if (watcher.watchdog !== undefined) clearTimeout(watcher.watchdog);

    watcher.watchdog = setTimeout(() => {
        void resume(watcher);
    }, WATCHDOG_MS);
}

export function watchForClose(event: IpcMainInvokeEvent): Promise<boolean> {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return Promise.resolve(false);

    const previous = watchers.get(event.sender.id);

    if (previous) {
        if (previous.requested) {
            void resume(previous);
            return Promise.resolve(false);
        }
        cleanup(previous);
    }

    return new Promise<boolean>(resolve => {
        const watcher: Watcher = {
            window,
            sender: event.sender,
            resolve,
            requested: false,
            kind: "window",

            onWindowClose(closeEvent) {
                closeEvent.preventDefault();
                requestClose("window");
            },

            onBeforeQuit(quitEvent) {
                quitEvent.preventDefault();
                requestClose("quit");
            },

            onDestroyed() {
                cleanup(watcher);
            },

            onNavigation(_event, _url, isInPlace, isMainFrame) {
                if (!isMainFrame || isInPlace) return;

                if (watcher.requested) void resume(watcher);
                else cleanup(watcher);
            }
        };

        function requestClose(kind: CloseKind) {
            if (kind === "quit") watcher.kind = "quit";
            if (watcher.requested) return;

            watcher.requested = true;
            watcher.backgroundThrottling = event.sender.getBackgroundThrottling();
            event.sender.setBackgroundThrottling(false);

            armWatchdog(watcher);
            watcher.resolve(true);
        }

        watchers.set(event.sender.id, watcher);
        window.on("close", watcher.onWindowClose);
        app.on("before-quit", watcher.onBeforeQuit);
        event.sender.on("destroyed", watcher.onDestroyed);
        event.sender.on("did-start-navigation", watcher.onNavigation);
    });
}

export function keepWaiting(event: IpcMainInvokeEvent) {
    const watcher = watchers.get(event.sender.id);
    if (watcher?.requested) armWatchdog(watcher);
}

export function finishClose(event: IpcMainInvokeEvent): Promise<boolean> {
    const watcher = watchers.get(event.sender.id);
    return watcher?.requested ? resume(watcher) : Promise.resolve(false);
}

export function cancelCloseWatcher(event: IpcMainInvokeEvent) {
    const watcher = watchers.get(event.sender.id);
    if (!watcher) return;

    if (watcher.requested) return resume(watcher);
    cleanup(watcher);
}
