// Chrome extension API types are provided by @types/chrome (see tsconfig `types`).

interface AxNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  states: string[];
  attributes: Record<string, string>;
  childIds: number[];
  backendDOMNodeId: number;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

interface AxTree {
  nodes: AxNode[];
}

// --- Fallback AX-tree helpers (isolated world) --------------------------------
// These run directly in the content script's ISOLATED world, which shares the
// page's DOM but not its JS `window`. They used to be serialized into an
// injected <script> that ran in the MAIN world and wrote
// `window.__axTreeSnapshot`; the isolated world can never see that global
// (separate JS contexts), so the fallback always returned an empty tree.
// Computing the tree in-place removes the cross-world handoff entirely.

function axIsSensitive(el: Element): boolean {
  const input = el as HTMLInputElement;
  const type = (input.type || '').toLowerCase();
  if (type === 'password') return true;
  const ac = (input.autocomplete || '').toLowerCase();
  if (['cc-', 'cvc', 'cvv', 'card', 'account-number', 'one-time-code', 'otp', 'new-password', 'current-password'].some(t => ac.includes(t))) return true;
  const id = (input.name || '') + ' ' + (input.id || '');
  return /(password|passwd|pwd|secret|token|api[_-]?key|authorization|credential|credit|card|cvv|cvc|ssn|social)/i.test(id);
}

function axImplicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type;
  const roles: Record<string, string> = {
    'a': 'link', 'button': 'button', 'input': type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox',
    'select': 'combobox', 'textarea': 'textbox', 'option': 'option', 'img': 'img',
    'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
    'nav': 'navigation', 'main': 'main', 'aside': 'complementary', 'header': 'banner', 'footer': 'contentinfo',
    'form': 'form', 'table': 'table', 'ul': 'list', 'ol': 'list', 'li': 'listitem',
  };
  return roles[tag] || 'generic';
}

function axStates(el: Element): string[] {
  const states: string[] = [];
  const input = el as HTMLInputElement;
  if (el.hasAttribute('disabled') || input.disabled) states.push('disabled');
  if (el.hasAttribute('required')) states.push('required');
  if (el.hasAttribute('readonly')) states.push('readonly');
  if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') states.push('hidden');
  if (el.hasAttribute('aria-invalid') && el.getAttribute('aria-invalid') === 'true') states.push('invalid');
  if (el === document.activeElement) states.push('focused');
  if (el.checkVisibility()) states.push('visible'); else states.push('invisible');
  return states;
}

function axAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    // Never capture the live value of a secret field as an attribute.
    if (axIsSensitive(el) && (attr.name === 'value' || attr.name === 'aria-valuetext')) continue;
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

class AxTreeExtractor {
  private cdpSessionId: string | null = null;
  private observer: MutationObserver | null = null;
  private lastSnapshot: AxTree | null = null;
  private snapshotCallbacks: Map<string, (tree: AxTree) => void> = new Map();
  private requestId = 0;

  constructor() {
    this.init();
  }

  private async init() {
    // Listen for messages from service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    // Request CDP attachment from service worker
    await this.attachToCdp();
  }

  private async attachToCdp() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CDP_ATTACH_REQUEST' });
      if (response?.sessionId) {
        this.cdpSessionId = response.sessionId;
        console.log('[AX Extractor] CDP attached:', this.cdpSessionId);
      }
    } catch (e) {
      console.log('[AX Extractor] CDP not available, using fallback');
    }
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'GET_AX_TREE':
        this.getAxTree().then(tree => sendResponse({ axTree: tree }));
        break;
      case 'CDP_ATTACHED':
        if (message.payload?.sessionId) {
          this.cdpSessionId = message.payload.sessionId;
          console.log('[AX Extractor] CDP session updated:', this.cdpSessionId);
        }
        sendResponse({ success: true });
        break;
      case 'CDP_DETACHED':
        this.cdpSessionId = null;
        sendResponse({ success: true });
        break;
    }
  }

  async getAxTree(): Promise<AxTree | null> {
    if (this.cdpSessionId) {
      try {
        return await this.fetchAxTreeViaCdp();
      } catch (e) {
        console.warn('[AX Extractor] CDP fetch failed, using fallback:', e);
      }
    }
    return this.fetchAxTreeFallback();
  }

  private async fetchAxTreeViaCdp(): Promise<AxTree> {
    const response = await this.sendCdpCommand('Accessibility', 'getFullAXTree', {});
    return this.convertCdpAxTree(response);
  }

  private fetchAxTreeFallback(): Promise<AxTree> {
    // Compute the AX tree directly in the isolated content script. The DOM is
    // shared with the page, so getBoundingClientRect / getComputedStyle /
    // attributes are all available here; there is no need (and no safe way) to
    // hand the result across the MAIN/ISOLATED world boundary via a window
    // global.
    const nodes: AxNode[] = [];
    const idMap = new WeakMap<Element, number>();
    let nodeId = 0;
    const getId = (el: Element): number => {
      if (!idMap.has(el)) idMap.set(el, ++nodeId);
      return idMap.get(el)!;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode as Element;
      const rect = el.getBoundingClientRect();

      nodes.push({
        role: el.getAttribute('role') || axImplicitRole(el),
        name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.textContent || '').trim().slice(0, 100),
        value: axIsSensitive(el) ? '' : ((el as HTMLInputElement).value || ''),
        description: el.getAttribute('aria-description') || '',
        states: axStates(el),
        attributes: axAttributes(el),
        childIds: Array.from(el.children).map(getId),
        backendDOMNodeId: getId(el),
        rect: rect.width > 0 && rect.height > 0 ? {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
        } : undefined,
      });
    }

    return Promise.resolve({ nodes });
  }

  private convertCdpAxTree(cdpTree: any): AxTree {
    // Convert CDP accessibility tree format to our internal format
    return {
      nodes: (cdpTree.nodes || []).map((node: any) => ({
        role: node.role?.value || 'generic',
        name: node.name?.value || '',
        value: node.value?.value || '',
        description: node.description?.value || '',
        states: (node.states || []).map((s: any) => s.value),
        attributes: node.attributes || {},
        childIds: node.childIds || [],
        backendDOMNodeId: node.backendDOMNodeId,
        rect: node.rect ? {
          x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height,
          top: node.rect.y, right: node.rect.x + node.rect.width, bottom: node.rect.y + node.rect.height, left: node.rect.x
        } : undefined,
      })),
    };
  }

  private async sendCdpCommand(domain: string, command: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CDP_COMMAND',
        payload: { domain, command, params, sessionId: this.cdpSessionId },
      }, response => {
        if (response?.error) reject(new Error(response.error));
        else resolve(response?.result);
      });
    });
  }

  startObserving() {
    if (this.observer) return;

    this.observer = new MutationObserver(mutations => {
      // Debounce snapshot updates
      clearTimeout((this as any).debounceTimer);
      (this as any).debounceTimer = setTimeout(() => {
        this.getAxTree().then(tree => {
          this.lastSnapshot = tree;
          if (tree) this.notifyCallbacks(tree);
        });
      }, 300);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-*', 'role', 'disabled', 'hidden', 'class', 'id'],
    });
  }

  stopObserving() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private notifyCallbacks(tree: AxTree) {
    for (const [, callback] of this.snapshotCallbacks) {
      try {
        callback(tree);
      } catch (e) {
        console.warn('[AX Extractor] Callback error:', e);
      }
    }
  }
}

// Initialize extractor
const extractor = new AxTreeExtractor();
extractor.startObserving();

// Export for debugging
(window as any).__axExtractor = extractor;

console.log('[AX Extractor] Initialized');