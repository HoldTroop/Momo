// Human Input Simulation — Content Script Fallback
// Per Architecture Blueprint Section 7: transparent input, no deception
// "Human-like timing may be used only for usability—such as waiting for rendering or avoiding accidental double submission—not to deceive a destination site."
// NOTE: These produce untrusted events (isTrusted: false). For trusted events, use bridge via CDP Input API.

interface SimulationProfile {
  speed: number;
  jitter: number;
  errorRate: number;
}

class HumanInputSimulator {
  private profile: SimulationProfile;
  private isSimulating = false;

  constructor() {
    this.profile = { speed: 1.0, jitter: 0.0, errorRate: 0.0 };
    this.init();
  }

  private init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    if (import.meta.env.DEV) {
      console.log('[Human Input] Initialized (content script fallback - untrusted events)');
    }
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    const p = message.payload;
    if (!p || typeof p !== 'object') {
      sendResponse({ success: false, error: 'Missing payload' });
      return;
    }

    const sendError = (e: unknown) => sendResponse({ success: false, error: String(e) });

    try {
      switch (message.type) {
        case 'SIMULATE_CLICK': {
          const x = Number(p.x);
          const y = Number(p.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            sendResponse({ success: false, error: 'Invalid payload: x/y must be finite numbers' });
            return;
          }
          this.simulateClick(x, y, p.profile)
            .then(() => sendResponse({ success: true }))
            .catch(sendError);
          break;
        }
        case 'SIMULATE_TYPE':
          if (typeof p.text !== 'string') {
            sendResponse({ success: false, error: 'Invalid payload: text must be a string' });
            return;
          }
          this.simulateType(p.text, p.profile)
            .then(() => sendResponse({ success: true }))
            .catch(sendError);
          break;
        case 'SIMULATE_SCROLL': {
          const x = Number(p.x);
          const y = Number(p.y);
          const deltaX = Number(p.deltaX);
          const deltaY = Number(p.deltaY);
          if (![x, y, deltaX, deltaY].every(Number.isFinite)) {
            sendResponse({ success: false, error: 'Invalid payload: x/y/deltaX/deltaY must be finite numbers' });
            return;
          }
          this.simulateScroll(x, y, deltaX, deltaY, p.profile)
            .then(() => sendResponse({ success: true }))
            .catch(sendError);
          break;
        }
        case 'SIMULATE_MOUSE_MOVE': {
          const fromX = Number(p.fromX);
          const fromY = Number(p.fromY);
          const toX = Number(p.toX);
          const toY = Number(p.toY);
          if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            sendResponse({ success: false, error: 'Invalid payload: fromX/fromY/toX/toY must be finite numbers' });
            return;
          }
          this.simulateMouseMove(fromX, fromY, toX, toY, p.profile)
            .then(() => sendResponse({ success: true }))
            .catch(sendError);
          break;
        }
        case 'SET_PROFILE':
          this.profile = { ...this.profile, ...p };
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ success: false, error: `Unknown message type: ${String(message.type)}` });
      }
    } catch (e) {
      sendResponse({ success: false, error: String(e) });
    }
  }

  async simulateClick(x: number, y: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };
    this.isSimulating = true;

    try {
      // Simple move to target
      this.dispatchMouseEvent('mousemove', x, y, 0);

      // Small dwell for usability (not deception)
      await this.sleep(20);

      // Click sequence
      this.dispatchMouseEvent('mousedown', x, y, 0);
      await this.sleep(10);
      this.dispatchMouseEvent('mouseup', x, y, 0);
      this.dispatchMouseEvent('click', x, y, 0);

    } finally {
      this.isSimulating = false;
    }
  }

  async simulateType(text: string, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };
    this.isSimulating = true;

    try {
      for (const ch of text) {
        const { key, code } = this.keyDescriptor(ch);
        this.dispatchKeyEventWithCode('keydown', key, code);
        await this.sleep(10);
        this.dispatchKeyEventWithCode('keyup', key, code);
        this.insertChar(ch);
        await this.sleep(10);
      }
    } finally {
      this.isSimulating = false;
    }
  }

  async simulateScroll(x: number, y: number, deltaX: number, deltaY: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };

    // Use native wheel event (content script fallback)
    const el = document.elementFromPoint(x, y);
    if (el) {
      const steps = Math.max(1, Math.ceil(Math.abs(deltaY) / 50));
      for (let i = 0; i < steps; i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaX: deltaX / steps,
          deltaY: deltaY / steps,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }));
        await this.sleep(16 * p.speed);
      }
    }
  }

  async simulateMouseMove(fromX: number, fromY: number, toX: number, toY: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };

    const distance = Math.hypot(toX - fromX, toY - fromY);
    if (distance < 1) return;

    // Simple linear interpolation for usability
    const steps = Math.min(20, Math.max(5, Math.ceil(distance / 10)));
    const dt = 1 / 60;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const x = fromX + (toX - fromX) * progress;
      const y = fromY + (toY - fromY) * progress;

      this.dispatchMouseEvent('mousemove', x, y, 0);
      await this.sleep(16);
    }
  }

  private dispatchMouseEvent(type: string, x: number, y: number, button: number) {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button,
      buttons: type === 'mousedown' ? 1 : type === 'mouseup' ? 0 : 0,
      bubbles: true,
      cancelable: true,
      view: window,
      // NOTE: isTrusted will be false - this is content script fallback
      // For trusted events, use bridge via CDP Input API
    });

    const target = document.elementFromPoint(x, y) || document.body;
    // M4: the child frame's own content script dispatches its events;
    // dispatching here too would double-fire.
    if (target.tagName === 'IFRAME' || target.tagName === 'FRAME') return;
    target.dispatchEvent(event);
  }

  private keyDescriptor(ch: string): { key: string; code: string } {
    if (ch === ' ') return { key: ' ', code: 'Space' };
    if (ch === 'Enter') return { key: 'Enter', code: 'Enter' };
    if (ch === 'Backspace') return { key: 'Backspace', code: 'Backspace' };
    if (ch === 'Tab') return { key: 'Tab', code: 'Tab' };
    if (/^[a-zA-Z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}` };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}` };
    if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}` };
    return { key: ch, code: '' };
  }

  private insertChar(ch: string): void {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    const tag = active.tagName?.toLowerCase() ?? '';
    const isEditable = tag === 'input' || tag === 'textarea' || (active as HTMLElement).isContentEditable === true;
    if (!isEditable) return;
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(active, (active as HTMLInputElement).value + ch);
    } else {
      (active as HTMLInputElement).value += ch;
    }
    active.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true, composed: true }));
  }

  private dispatchKeyEventWithCode(type: string, key: string, code: string) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
    });

    (document.activeElement || document.body).dispatchEvent(event);
  }

  private dispatchKeyEvent(type: string, key: string) {
    const keyMap: Record<string, { key: string; code: string }> = {
      'Backspace': { key: 'Backspace', code: 'Backspace' },
      'Enter': { key: 'Enter', code: 'Enter' },
      'Tab': { key: 'Tab', code: 'Tab' },
      ' ': { key: ' ', code: 'Space' },
    };

    const mapping = keyMap[key] || { key: key.toUpperCase(), code: `Key${key.toUpperCase()}` };
    this.dispatchKeyEventWithCode(type, mapping.key, mapping.code);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const humanInput = new HumanInputSimulator();
(window as any).__humanInput = humanInput;