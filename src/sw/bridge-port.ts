// Port discovery for the Rust bridge WebSocket server.
// The bridge writes its ephemeral port to a well-known file on startup.

export async function discoverBridgePort(): Promise<number> {
  // 1. Try env var (set by bridge at startup) - not available in extension context directly
  // but we can check if it's passed via native messaging or command line

  // 2. Try well-known file: ~/.momo/bridge_port
  try {
    // In a Chrome extension, we can't read files directly.
    // We use native messaging to ask a helper, or the bridge writes to a location
    // accessible via chrome.storage.local or we scan ports.
    // For now, we'll scan ports as the primary method.
  } catch {}

  // 3. Fallback: scan 9000-9100 for /health endpoint
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