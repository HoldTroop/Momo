// Shared selector generation logic
// Used by both DomCompressor (AX tree) and Perception module (DOM) for consistency.

/**
 * Generate a stable CSS selector for an element.
 * This is the single source of truth for selector generation across the codebase.
 */
export function generateSelector(el: Element): string {
  // Try ID first
  if (el.id) {
    return ensureUnique(`#${CSS.escape(el.id)}`, el);
  }

  // Try data-testid
  if (el.hasAttribute('data-testid')) {
    return ensureUnique(`[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]`, el);
  }

  // Build path from ancestors
  const path: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < 5) {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      segment = `#${CSS.escape(current.id)}`;
      path.unshift(segment);
      break;
    }

    if (current.className && typeof current.className === 'string') {
      const classes = current.className
        .split(' ')
        .filter(c => c.length > 1)
        .slice(0, 2);
      if (classes.length > 0) {
        segment += `.${classes.map(c => CSS.escape(c)).join('.')}`;
      }
    }

    path.unshift(segment);
    current = current.parentElement;
    depth++;
  }

  return ensureUnique(path.join(' > ') || '', el);
}

function ensureUnique(sel: string, el: Element): string {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return sel;
  if (!sel || document.querySelectorAll(sel).length <= 1) return sel;
  return `${sel}:nth-of-type(${nthOfTypeIndex(el)})`;
}

function nthOfTypeIndex(el: Element): number {
  let i = 1;
  for (let sib = el.parentElement?.firstElementChild; sib && sib !== el; sib = sib.nextElementSibling) {
    if (sib.tagName === el.tagName) i++;
  }
  return i;
}

/**
 * Check if an element is actionable (clickable, typeable, etc.).
 * Single source of truth for actionability across DomCompressor and Perception.
 */
export function isActionable(el: HTMLElement): boolean {
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'combobox', 'searchbox',
    'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'treeitem', 'gridcell', 'rowheader', 'columnheader',
    'slider', 'spinbutton', 'switch', 'tooltip', 'listbox', 'option',
    'menu', 'menubar', 'toolbar', 'scrollbar',
  ]);

  const role = el.getAttribute('role') || getImplicitRole(el);
  if (interactiveRoles.has(role)) return true;
  if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
  if (el.onclick || el.onkeydown) return true;
  return false;
}

export function getImplicitRole(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') {
    return el.hasAttribute('href') ? 'link' : 'generic';
  }
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'hidden') return 'generic';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'textbox';
  }
  const roles: Record<string, string> = {
    'button': 'button',
    'select': 'combobox',
    'textarea': 'textbox',
    'option': 'option',
    'img': 'img',
    'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
    'nav': 'navigation',
    'main': 'main',
    'aside': 'complementary',
    'header': 'banner',
    'footer': 'contentinfo',
    'form': 'form',
    'table': 'table',
    'ul': 'list', 'ol': 'list', 'li': 'listitem',
  };
  return roles[tag] || 'generic';
}
