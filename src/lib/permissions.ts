/** Ensure the optional `debugger` permission is granted; request it if not. */
export async function ensureDebuggerPermission(): Promise<boolean> {
  try {
    const granted = await chrome.permissions.contains({ permissions: ['debugger'] });
    if (granted) return true;
    return await chrome.permissions.request({ permissions: ['debugger'] });
  } catch (e) {
    console.warn('[Permissions] debugger permission check/request failed:', e);
    return false;
  }
}

/** Ensure host access for a page URL is granted; request it if not. */
export async function ensureHostPermission(url: string | undefined): Promise<boolean> {
  if (!url) return true; // nothing to gate on
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return true;
  }
  if (!origin.startsWith('http://') && !origin.startsWith('https://')) return true; // extension/chrome pages: not gateable
  try {
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (granted) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    console.warn('[Permissions] host permission check/request failed:', e);
    return false;
  }
}
