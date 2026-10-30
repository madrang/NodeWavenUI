/**
 * The `permission-request` custom element: one card for one pending permission request.
 * Any surface can drop the element in and listen for its resolve event, so the chat tabs, a future
 * notification center, or a settings page all reuse the same card.
 *
 * Usage: set the `request` property, listen for the `permission-resolve` event
 * with `{ id, approve, remember }` in the detail, and forward it to `PermissionGate.resolveRequest`.
 */

import type { PermissionRequestInfo } from './permission-gate.js';

/** The resolve detail of the permission-request element. */
export interface PermissionResolveDetail {
  readonly id: number;
  readonly approve: boolean;
  readonly remember: boolean;
}

/** One pending permission request card. */
export class PermissionRequestElement extends HTMLElement {
  private info: PermissionRequestInfo | null = null;

  /** Registers the element once. */
  static define(): void {
    if (customElements.get('permission-request') === undefined) {
      customElements.define('permission-request', PermissionRequestElement);
    }
  }

  /** The request the card shows. Setting it re-renders the card. */
  set request(info: PermissionRequestInfo) {
    this.info = info;
    this.render();
  }

  private dispatchResolve(approve: boolean, remember: boolean): void {
    const info = this.info;
    if (info === null) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<PermissionResolveDetail>('permission-resolve', {
        detail: { id: info.id, approve, remember },
      }),
    );
  }

  private render(): void {
    const info = this.info;
    this.replaceChildren();
    if (info === null) {
      return;
    }
    const line = document.createElement('p');
    line.className = 'permission-request-line';
    line.textContent = `"${info.principal}" requests "${info.action}" on ${info.target}.`;
    const detail = document.createElement('p');
    detail.className = 'permission-request-detail';
    detail.textContent = info.detail;
    const remember = document.createElement('label');
    remember.className = 'permission-request-remember';
    const rememberBox = document.createElement('input');
    rememberBox.type = 'checkbox';
    remember.append(rememberBox, document.createTextNode(' Always apply this choice'));
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => {
      this.dispatchResolve(true, rememberBox.checked);
    });
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => {
      this.dispatchResolve(false, rememberBox.checked);
    });
    const actions = document.createElement('div');
    actions.className = 'permission-request-actions';
    actions.append(remember, approve, deny);
    this.append(line, detail, actions);
  }
}
