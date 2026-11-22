// A workspace clear invalidates asynchronous installers even when saved durable ids repeat.
let current = {};
export const captureWorkspace = (): object => current;
export const isCurrentWorkspace = (token: object): boolean => token === current;
export function replaceWorkspace(): void { current = {}; }
