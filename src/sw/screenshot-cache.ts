/**
 * Ephemeral screenshot storage with optional persistence.
 *
 * Default: in-memory only (cleared on tab navigation or session end).
 * Optional: user can enable "screenshot history" mode via settings.
 *
 * Design decision: actions-6 from docs/PHASE_2_DECISIONS.md
 */

export interface ScreenshotRef {
  ref_id: string;
  timestamp: number;
  url: string;
  tabId: number;
}

export class ScreenshotCache {
  private memoryCache: Map<string, Blob> = new Map();
  private metadata: Map<string, ScreenshotRef> = new Map();

  /**
   * Store a screenshot in memory and return its ref_id.
   * Audit log records metadata but image data is ephemeral.
   */
  store(blob: Blob, tabId: number, url: string): string {
    const ref_id = `screenshot_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    this.memoryCache.set(ref_id, blob);
    this.metadata.set(ref_id, {
      ref_id,
      timestamp: Date.now(),
      url,
      tabId,
    });

    return ref_id;
  }

  /**
   * Retrieve a screenshot by ref_id. Returns null if not found or expired.
   */
  get(ref_id: string): Blob | null {
    return this.memoryCache.get(ref_id) ?? null;
  }

  /**
   * Get metadata for a screenshot without loading the blob.
   */
  getMetadata(ref_id: string): ScreenshotRef | null {
    return this.metadata.get(ref_id) ?? null;
  }

  /**
   * Clear all screenshots for a specific tab (called on navigation).
   */
  clearTab(tabId: number): void {
    const toDelete: string[] = [];

    for (const [ref_id, meta] of this.metadata.entries()) {
      if (meta.tabId === tabId) {
        toDelete.push(ref_id);
      }
    }

    for (const ref_id of toDelete) {
      this.memoryCache.delete(ref_id);
      this.metadata.delete(ref_id);
    }
  }

  /**
   * Clear all screenshots (called on session end).
   */
  clearAll(): void {
    this.memoryCache.clear();
    this.metadata.clear();
  }

  /**
   * List all screenshot metadata (for debugging/audit).
   */
  listMetadata(): ScreenshotRef[] {
    return Array.from(this.metadata.values());
  }
}

// Singleton instance
export const screenshotCache = new ScreenshotCache();
