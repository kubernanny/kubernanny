import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { SheetSection } from './module-sheet-view';

/** One structured part of a module sheet: its objects as a list (problems first, healthy rows folded) or a short table. */
@Component({
  selector: 'app-detail-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (section(); as s) {
        <section class="detail">
          <h2>{{ s.title }} <span class="count">{{ s.count }}</span></h2>
          @if (s.kind === 'list') {
            <ul class="rows">
              @for (r of s.rows; track r.key) {
                <li [class]="'tone-' + r.tone" [class.problem]="r.problem">
                  <span class="dot" aria-hidden="true"></span>
                  <div class="main">
                    <span class="rname">{{ r.name }}</span>
                    @if (r.sub) {
                      <span class="rsub">{{ r.sub }}</span>
                    }
                    @if (r.meta.length > 0) {
                      <span class="rmeta">
                        @for (m of r.meta; track $index) {
                          <span [class]="'chip tone-' + (m.tone ?? 'muted')" [class.flag]="m.tone === 'warning' || m.tone === 'critical'">{{ m.text }}</span>
                        }
                      </span>
                    }
                  </div>
                  @if (r.value) {
                    <span class="rvalue">{{ r.value }}</span>
                  }
                  @if (r.children.length > 0) {
                    <ul class="children">
                      @for (c of r.children; track c.key) {
                        <li [class]="'tone-' + c.tone">
                          <span class="dot" aria-hidden="true"></span>
                          <div class="main">
                            <span class="cname">{{ c.name }}</span>
                            @if (c.sub) {
                              <span class="rsub">{{ c.sub }}</span>
                            }
                            @if (c.meta.length > 0) {
                              <span class="rmeta">
                                @for (m of c.meta; track $index) {
                                  <span [class]="'chip tone-' + (m.tone ?? 'muted')" [class.flag]="m.tone === 'warning' || m.tone === 'critical'">{{ m.text }}</span>
                                }
                              </span>
                            }
                          </div>
                          @if (c.value) {
                            <span class="rvalue">{{ c.value }}</span>
                          }
                        </li>
                      }
                    </ul>
                  }
                </li>
              }
            </ul>
            @if (s.folded > 0) {
              <button type="button" class="more" (click)="toggle.emit()">{{ s.expandLabel }}</button>
            } @else if (expanded()) {
              <button type="button" class="more" (click)="toggle.emit()">{{ t('module.showLess') }}</button>
            }
          } @else {
            <table class="grid">
              <thead>
                <tr>
                  @for (c of s.columns; track $index) {
                    <th scope="col">{{ c }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (r of s.rows; track r.key) {
                  <tr [class]="'tone-' + r.tone">
                    @for (c of r.cells; track $index) {
                      <td>{{ c }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          }
          @if (s.more > 0) {
            <p class="muted hint">{{ t('module.moreRows', { n: s.more }) }}</p>
          }
        </section>
      }
    </ng-container>
  `,
  styles: `
    .children {
      grid-column: 2 / -1;
      list-style: none;
      margin: 0.45rem 0 0;
      padding: 0 0 0 0.6rem;
      border-left: 2px solid var(--line);
      display: grid;
      gap: 0.4rem;
    }
    .children li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 0 0.5rem;
      align-items: start;
      font-size: 0.875rem;
    }
    .children .dot {
      width: 0.4rem;
      height: 0.4rem;
      margin-top: 0.4rem;
    }
    .cname {
      font-weight: 550;
      overflow-wrap: anywhere;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 1.5rem 0 0.6rem;
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .count {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    .hint {
      font-size: 0.875rem;
      margin: 0.4rem 0 0;
    }
    .detail {
      margin-top: 0.25rem;
    }
    .rows {
      list-style: none;
      padding: 0;
      margin: 0;
      border-radius: var(--radius-l);
      background: var(--surface);
      overflow: hidden;
    }
    .rows > li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 0 0.65rem;
      align-items: start;
      padding: 0.55rem 0.9rem;
      border-top: 1px solid var(--line);
    }
    .rows > li:first-child {
      border-top: none;
    }
    /* A problem row stands out by its rail and a lifted surface, not a tint that turns muddy on dark navy. */
    .rows > li.problem {
      background: var(--raise);
      box-shadow: inset 3px 0 0 var(--tone);
      padding-top: 0.7rem;
      padding-bottom: 0.7rem;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--tone);
      margin-top: 0.45rem;
    }
    .tone-muted > .dot {
      background: transparent;
      box-shadow: inset 0 0 0 1.5px var(--mute);
    }
    .main {
      display: grid;
      gap: 0.1rem;
      min-width: 0;
    }
    .rname {
      font-weight: 600;
      font-size: 0.9375rem;
      overflow-wrap: anywhere;
    }
    .rsub {
      color: var(--ink-2);
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .rmeta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.15rem 0.75rem;
      font-size: 0.8125rem;
      color: var(--mute);
    }
    .chip.flag {
      color: var(--tone);
      font-weight: 600;
    }
    .rvalue {
      font-weight: 600;
      font-size: 0.875rem;
      color: var(--ink-2);
      text-align: right;
      max-width: 9.5rem;
      overflow-wrap: anywhere;
      padding-top: 0.05rem;
    }
    .problem > .rvalue {
      color: var(--tone);
    }
    .more {
      margin-top: 0.4rem;
      padding: 0.45rem 0.2rem;
      border: none;
      background: none;
      color: var(--accent);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .grid {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border-radius: var(--radius-l);
      overflow: hidden;
      font-size: 0.875rem;
    }
    .grid th {
      text-align: left;
      color: var(--mute);
      font-weight: 500;
      font-size: 0.75rem;
      padding: 0.55rem 0.9rem 0.35rem;
    }
    .grid td {
      padding: 0.5rem 0.9rem;
      border-top: 1px solid var(--line);
      overflow-wrap: anywhere;
      vertical-align: top;
    }
    .grid td:not(:first-child),
    .grid th:not(:first-child) {
      white-space: nowrap;
    }
    .grid td:first-child {
      font-weight: 600;
    }
    .grid tr.tone-warning td,
    .grid tr.tone-critical td {
      background: var(--raise);
      color: var(--tone);
    }
  `,
})
export class DetailSectionView {
  readonly section = input.required<SheetSection>();
  /** Healthy rows are all shown. */
  readonly expanded = input(false);
  readonly toggle = output<void>();
}
