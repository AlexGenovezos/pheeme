// Runs inside QuickJS. No browser, Node, module loader, or Tauri globals exist.
(() => {
  const send = globalThis.__host;
  delete globalThis.__host;
  const pending = new Map();
  const handlers = new Map();
  const timers = new Map();
  let sequence = 0;
  const rpc = (method, args) => new Promise((resolve, reject) => {
    if (pending.size >= 32) throw new Error("Too many pending mod operations");
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try { send(JSON.stringify({ id, method, args })); }
    catch (error) { pending.delete(id); reject(error); }
  });
  const report = () => { send(JSON.stringify({ id: 0, method: "error", args: {} })); };
  const invoke = (handler, value) => {
    try { Promise.resolve(handler?.(value)).catch(report); } catch { report(); }
  };
  Object.defineProperty(globalThis, "__dispatch", { value: (json) => {
    const message = JSON.parse(json);
    if (message.type === "reply") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.value);
    } else if (message.type === "action") invoke(handlers.get(message.id), message.value);
    else if (message.type === "tick") {
      for (const timer of timers.values()) {
        if (message.now >= timer.next) {
          timer.next = message.now + timer.ms;
          invoke(timer.handler);
        }
      }
    }
  } });
  Object.defineProperty(globalThis, "pheeme", { value: Object.freeze({
    apiVersion: 1,
    on(id, handler) {
      if (typeof id !== "string" || typeof handler !== "function") throw new Error("Expected an action ID and handler");
      if (handlers.size >= 128 && !handlers.has(id)) throw new Error("Too many action handlers");
      handlers.set(id, handler);
      return () => handlers.delete(id);
    },
    render: (surface, blocks) => rpc("render", { surface, blocks }),
    storage: Object.freeze({ get: (key) => rpc("storage.get", { key }), set: (key, value) => rpc("storage.set", { key, value }) }),
    http: Object.freeze({ request: (request) => rpc("http", request) }),
    connections: Object.freeze({ status: (id) => rpc("connection.status", { id }) }),
    every(ms, handler) {
      if (!Number.isFinite(ms) || ms < 1000 || typeof handler !== "function" || timers.size >= 8) throw new Error("Use up to 8 timers, with an interval of at least 1000ms");
      const id = ++sequence;
      timers.set(id, { ms, next: Date.now() + ms, handler });
      return () => timers.delete(id);
    },
  }) });
})();
