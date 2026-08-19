// Port discovery for the Rust bridge WebSocket server.
// The bridge binds a fixed port in 9090-9100 (bridge/src/main.rs FIRST_PORT..LAST_PORT).
// Scan ascending; only accept a /health responder that returns body "ok"
// (the bridge's health route returns exactly "ok").
export async function discoverBridgeUrl(): Promise<string> {
  for (let port = 9090; port <= 9100; port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(100),
      });
      if (response.ok) {
        const body = (await response.text()).trim();
        if (body === 'ok') return `ws://127.0.0.1:${port}/ws`;
      }
    } catch { /* port not answering; try next */ }
  }
  throw new Error('Could not discover bridge port in 9090-9100');
}
