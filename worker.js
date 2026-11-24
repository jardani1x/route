/* Web Worker: runs RouteBackend (backend.js) off the page's main thread. */
/* global importScripts, RouteBackend */
importScripts('core.js', 'engine.js', 'backend.js');
const backend = RouteBackend((msg, move) => self.postMessage(msg, move || []));
let queue = Promise.resolve();
// one message at a time, in order: an edit always sees the state the previous edit left
self.onmessage = (e) => { queue = queue.then(() => backend.handle(e.data)).catch((err) => self.postMessage({ t: 'error', msg: String(err && err.message || err) })); };
