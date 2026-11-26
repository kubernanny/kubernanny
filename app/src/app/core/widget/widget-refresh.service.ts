import { inject, Injectable } from '@angular/core';

import { StatusStore } from '../status-store.service';
import { WidgetBridge } from './widget-bridge';
import { WidgetSync } from './widget-sync.service';

/** Longer than one status call with its quiet retries; past it the app goes back anyway. */
export const WIDGET_REFRESH_TIMEOUT_MS = 20_000;

/**
 * The refresh button on the Android widgets (kubernanny://refresh). The widget
 * holds no key and cannot ask an agent, so the button opens the app: this asks
 * every agent once, writes the widget's list and sends the app back to the
 * home screen. Not when the person started using the app meanwhile (a touch):
 * then it stays open.
 */
@Injectable({ providedIn: 'root' })
export class WidgetRefresh {
  private readonly status = inject(StatusStore);
  private readonly sync = inject(WidgetSync);
  private readonly bridge = inject(WidgetBridge);
  private running: Promise<void> | null = null;

  /** A second tap (or the launch URL and appUrlOpen of one cold start) joins the run under way. */
  run(): Promise<void> {
    this.running ??= this.refresh().finally(() => (this.running = null));
    return this.running;
  }

  private async refresh(): Promise<void> {
    let touched = false;
    const touch = () => (touched = true);
    document.addEventListener('pointerdown', touch, { capture: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.sync.loaded;
      await Promise.race([
        this.status.refreshAll(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, WIDGET_REFRESH_TIMEOUT_MS))),
      ]);
      // The effect writes on its own; this waits until the write is through.
      await this.sync.sync();
    } catch {
      // Whatever failed shows in the app; the widget keeps what it had.
    } finally {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', touch, { capture: true });
    }
    if (!touched) {
      await this.bridge.moveToBack();
    }
  }
}
