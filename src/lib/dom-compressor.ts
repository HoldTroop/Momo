import { CompressedDom, ActionableElement, DomRect, LayoutNode } from '../sw/orchestrator.js';
import { redactText } from './redaction.js';
import { generateSelector, isActionable } from './selector.js';

interface AxNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  states: string[];
  attributes: Record<string, string>;
  childIds: number[];
  backendDOMNodeId: number;
  rect?: DomRect;
}

interface AxTree {
  nodes: AxNode[];
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'searchbox',
  'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'gridcell', 'rowheader', 'columnheader',
  'slider', 'spinbutton', 'switch', 'tooltip', 'listbox', 'option',
  'menu', 'menubar', 'toolbar', 'scrollbar', 'spinbutton',
]);

const CONTAINER_ROLES = new Set([
  'group', 'region', 'section', 'article', 'main', 'nav', 'aside',
  'header', 'footer', 'form', 'fieldset', 'figure', 'dialog',
  'alert', 'alertdialog', 'status', 'log', 'marquee', 'timer',
]);

export class DomCompressor {
  private actionabilityCache: Map<string, number> = new Map();

  compress(axTree: AxTree | null, url: string, title: string): CompressedDom {
    if (!axTree || !axTree.nodes.length) {
      return this.emptyDom(url, title);
    }

    const nodesById = new Map<number, AxNode>();
    for (const node of axTree.nodes) {
      nodesById.set(node.backendDOMNodeId, node);
    }

    const actionableElements: ActionableElement[] = [];
    const visited = new Set<number>();

    for (const node of axTree.nodes) {
      if (this.isActionable(node) && this.isVisible(node)) {
        const selector = this.generateSelector(node, nodesById);
        if (selector) {
          const score = this.calculateActionability(node);
          actionableElements.push({
            selector,
            tag: this.roleToTag(node.role),
            role: node.role,
            label: redactText(node.name || node.value || node.description || 'unnamed'),
            bounds: node.rect || this.emptyRect(),
            actionabilityScore: score,
            backendNodeId: node.backendDOMNodeId,
          });
        }
      }
    }

    // Sort by actionability score descending
    actionableElements.sort((a, b) => b.actionabilityScore - a.actionabilityScore);

    // Limit to top N for token efficiency
    const topElements = actionableElements.slice(0, 100);

    const summary = this.generateSummary(topElements);
    const layout = this.buildLayoutTree(axTree.nodes[0], nodesById, visited);

    return {
      url: redactText(url),
      title: redactText(title),
      actions: topElements,
      summary,
      layout,
      timestamp: Date.now(),
    };
  }

  private isActionable(node: AxNode): boolean {
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (node.states.includes('focusable')) return true;
    if (node.attributes.onclick || node.attributes.onkeydown) return true;
    return false;
  }

  private isVisible(node: AxNode): boolean {
    // A missing rect means "geometry unknown", not "hidden": CDP AX nodes
    // (Accessibility.getFullAXTree) carry no bounding box, so treating an
    // absent rect as invisible silently dropped every actionable element from
    // the CDP path. Visibility is judged by explicit states/attributes; a rect,
    // when present, is an additional zero-size gate.
    if (node.states.includes('invisible') || node.states.includes('hidden')) return false;
    if (node.attributes.display === 'none' || node.attributes.visibility === 'hidden') return false;
    if (node.attributes.opacity === '0') return false;
    if (node.rect && (node.rect.width <= 0 || node.rect.height <= 0)) return false;
    return true;
  }

  private roleToTag(role: string): string {
    const roleToTagMap: Record<string, string> = {
      button: 'button',
      link: 'a',
      textbox: 'input',
      combobox: 'select',
      searchbox: 'input',
      checkbox: 'input',
      radio: 'input',
      menuitem: 'div',
      tab: 'button',
      slider: 'input',
      spinbutton: 'input',
      switch: 'button',
      listbox: 'select',
      option: 'option',
    };
    return roleToTagMap[role] || 'div';
  }

  private generateSelector(node: AxNode, nodesById: Map<number, AxNode>): string | null {
    // Try to build a stable CSS selector
    if (node.attributes.id) {
      return `#${node.attributes.id}`;
    }

    if (node.attributes['data-testid']) {
      return `[data-testid="${node.attributes['data-testid']}"]`;
    }

    // Build path from ancestors
    const path: string[] = [];
    let current: AxNode | undefined = node;
    let depth = 0;

    while (current && depth < 5) {
      let segment = current.role;
      if (current.attributes.id) {
        segment = `#${current.attributes.id}`;
        path.unshift(segment);
        break;
      }

      if (current.attributes.class) {
        const classes = current.attributes.class.split(' ').filter(c => c.length > 1).slice(0, 2);
        if (classes.length > 0) {
          segment += `.${classes.join('.')}`;
        }
      }

      path.unshift(segment);
      current = this.getParent(current, nodesById);
      depth++;
    }

    return path.join(' > ') || null;
  }

  private getParent(node: AxNode, nodesById: Map<number, AxNode>): AxNode | undefined {
    // Find parent by checking which node has this node in childIds
    for (const [, potentialParent] of nodesById) {
      if (potentialParent.childIds.includes(node.backendDOMNodeId)) {
        return potentialParent;
      }
    }
    return undefined;
  }

  private calculateActionability(node: AxNode): number {
    const cacheKey = `${node.backendDOMNodeId}-${node.role}-${node.name}`;
    if (this.actionabilityCache.has(cacheKey)) {
      return this.actionabilityCache.get(cacheKey)!;
    }

    let score = 0;

    // Role-based scoring
    const roleScores: Record<string, number> = {
      button: 0.9, link: 0.85, textbox: 0.8, combobox: 0.75,
      checkbox: 0.7, radio: 0.65, menuitem: 0.6, tab: 0.6,
      slider: 0.55, spinbutton: 0.5, switch: 0.5, searchbox: 0.8,
    };
    score += roleScores[node.role] || 0.3;

    // State bonuses
    if (node.states.includes('focusable')) score += 0.1;
    if (node.states.includes('required')) score += 0.1;
    if (node.states.includes('invalid')) score += 0.05;

    // Attribute bonuses
    if (node.attributes.onclick) score += 0.15;
    if (node.attributes.onkeydown) score += 0.1;
    if (node.attributes['data-action']) score += 0.1;
    if (node.attributes.href) score += 0.1;
    if (node.attributes.type === 'submit') score += 0.15;

    // Name/label presence
    if (node.name) score += 0.1;
    if (node.value) score += 0.05;

    // Visibility and position
    if (node.rect) {
      const viewportHeight = window.innerHeight || 800;
      if (node.rect.top < viewportHeight) score += 0.1;
      if (node.rect.width > 20 && node.rect.height > 20) score += 0.05;
    }

    const finalScore = Math.min(score, 1.0);
    this.actionabilityCache.set(cacheKey, finalScore);
    return finalScore;
  }

  private generateSummary(elements: ActionableElement[]): string {
    const roleCounts: Record<string, number> = {};
    for (const el of elements) {
      roleCounts[el.role] = (roleCounts[el.role] || 0) + 1;
    }

    const parts = Object.entries(roleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([role, count]) => `${count} ${role}${count > 1 ? 's' : ''}`);

    return `Page has ${elements.length} actionable elements: ${parts.join(', ')}`;
  }

  private buildLayoutTree(rootNode: AxNode | undefined, nodesById: Map<number, AxNode>, visited: Set<number>): LayoutNode {
    if (!rootNode || visited.has(rootNode.backendDOMNodeId)) {
      return { role: 'root', bounds: this.emptyRect(), children: [] };
    }

    visited.add(rootNode.backendDOMNodeId);

    const children: LayoutNode[] = [];
    for (const childId of rootNode.childIds) {
      const child = nodesById.get(childId);
      if (child) {
        children.push(this.buildLayoutTree(child, nodesById, visited));
      }
    }

    return {
      role: rootNode.role,
      bounds: rootNode.rect || this.emptyRect(),
      children: children.slice(0, 20), // Limit children
    };
  }

  private emptyDom(url: string, title: string): CompressedDom {
    return {
      url: redactText(url),
      title: redactText(title),
      actions: [],
      summary: 'Empty or inaccessible page',
      layout: { role: 'root', bounds: this.emptyRect(), children: [] },
      timestamp: Date.now(),
    };
  }

  private emptyRect(): DomRect {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  }
}