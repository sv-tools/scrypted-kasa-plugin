// Wraps an async operation so that calls made while one is still running share that run
// instead of starting another. Used wherever the same operation can be triggered from several
// places at once (a constructor, a settings change, a button pressed twice) and running it in
// parallel would double the requests to one device or race its replies.
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | undefined;
    return () =>
        (inFlight ??= run().finally(() => {
            inFlight = undefined;
        }));
}
