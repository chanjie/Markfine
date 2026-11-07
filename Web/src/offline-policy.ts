/** Defense in depth for trusted dependency code. CSP also covers DOM/CSS resource requests.
 * No arguments/URLs are included in diagnostics. External links are native, explicit user actions.
 */
const installed = Symbol.for('Markfine.offlinePolicy');
if (typeof window !== 'undefined' && !(globalThis as unknown as Record<symbol, unknown>)[installed]) {
  Object.defineProperty(globalThis, installed, { value: true });
  const blocked = function (): never {
    window.dispatchEvent(new Event('markfine-offline-blocked'));
    throw new DOMException('Markfine is offline. Network access is disabled.', 'SecurityError');
  };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker', 'SharedWorker', 'open']) {
    Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false });
  }
  Object.defineProperty(navigator, 'sendBeacon', { value: blocked, writable: false, configurable: false });
}
export {};
