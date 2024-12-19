let isDebugMode = false;

export function setDebugMode(debugMode: boolean) {
    isDebugMode = debugMode;
}

export function devLog(...args: string[]) {
    if (isDebugMode) {
        console.log(...args);
    }
}

export function devWarn(...args: string[]) {
    if (isDebugMode) {
        console.warn(...args);
    }
}

export function devError(...args: string[]) {
    if (isDebugMode) {
        console.error(...args);
    }
}
