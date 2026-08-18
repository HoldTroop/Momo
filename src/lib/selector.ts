// Shared selector generation logic
// Used by both DomCompressor (AX tree) and Perception module (DOM) for consistency.

/**
 * Generate a stable CSS selector for an element.
 * This is the single source of truth for selector generation across the codebase.
 */
export function generateSelector(el: Element): string {
  // Try ID first
  if (el.id) {
    return `#${el.id}`;
  }

  // Try data-testid
  if (el.hasAttribute('data-testid')) {
    return `[data-testid="${el.getAttribute('data-testid')}"]`;
  }

  // Build path from ancestors
  const path: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < 5) {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      segment = `#${current.id}`;
      path.unshift(segment);
      break;
    }

    if (current.className && typeof current.className === 'string') {
      const classes = current.className
        .split(' ')
        .filter(c => c.length > 1)
        .slice(0, 2);
      if (classes.length > 0) {
        segment += `.${classes.join('.')}`;
      }
    }

    path.unshift(segment);
    current = current.parentElement;
    depth++;
  }

  return path.join(' > ') || '';
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
  const type = (el as HTMLInputElement).type;
  const roles: Record<string, string> = {
    'a': 'link',
    'button': 'button',
    'input': type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox',
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