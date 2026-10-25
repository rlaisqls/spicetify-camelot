// Minimal Chrome DevTools Protocol client for evaluating code inside the running Spotify client.
// Spotify must expose a debugging port (spicetify enable-devtools); set CDP_PORT if it is not 8088.

export async function connect(port = process.env.CDP_PORT ?? 8088) {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && t.url.includes("xpui"));
  if (!page) throw new Error(`no Spotify page on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  let nextId = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== id) return;
        ws.removeEventListener("message", onMessage);
        const err = msg.error ?? msg.result?.exceptionDetails;
        if (err) reject(new Error(err.exception?.description ?? JSON.stringify(err)));
        else resolve(msg.result);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;

  return { send, evaluate, close: () => ws.close() };
}
