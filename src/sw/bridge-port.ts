// Port discovery for the Rust bridge WebSocket server. The bridge binds a
// fixed port in 9090-9100 (bridge/src/main.rs); the MV3 extension scans that
// range for its /health endpoint.

export async function discoverBridgePort(): Promise<number> {
  // Scan 9000-9100 for /health endpoint
  for (let port = 9000; port <= 9100; port++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        return port;
      }
    } catch {
      // Continue scanning
    }
  }

  throw new Error('Could not discover bridge port on 9000-9100');
}

export async function discoverBridgeUrl(): Promise<string> {
  const port = await discoverBridgePort();
  return `ws://127.0.0.1:${port}/ws`;
}