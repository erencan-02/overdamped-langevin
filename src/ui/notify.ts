/**
 * Short messages to the user from parts that do not know the toolbar (e.g. a plot's export
 * button). The app connects this to its toasts at start (app/actions.ts); until then (and in
 * tests) messages go to the console.
 */
let sink: (message: string) => void = (message) => console.warn(message);

export function notify(message: string): void {
  sink(message);
}

export function setNotifier(show: (message: string) => void): void {
  sink = show;
}
