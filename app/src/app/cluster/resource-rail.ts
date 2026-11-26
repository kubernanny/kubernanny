import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { ResourceBar } from '../ui/resource-bar';
import { RailView } from './cluster-view';

/**
 * The cluster's figures: the small counts in one row (two by two where the
 * rail is narrow), then CPU and RAM across the full width with their bar and a
 * one-line legend, and under each a thin bar per node, problem nodes first, so
 * nodes compare at a glance. Used in the desktop rail and on the phone's
 * overview (there without the per-node rows: the "Pro Node" section has them).
 */
@Component({
  selector: 'app-resource-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, ResourceBar, IonIcon],
  template: `
    <ng-container *transloco="let t">
      <dl class="small">
        @for (k of rail().small; track k.label) {
          <div [class]="'tone-' + k.tone">
            <dt>{{ k.label }}</dt>
            <dd class="value display">{{ k.value }}</dd>
            <dd class="note">{{ k.note }}</dd>
          </div>
        }
      </dl>
      @for (r of rail().resources; track r.key) {
        <section class="res">
          @if (r.bar; as b) {
            <app-resource-bar [resource]="b" [label]="r.label" [oneLine]="true" />
          } @else {
            <div [class]="'plain tone-' + r.tone">
              <span class="label">{{ r.label }}</span>
              <span
                ><strong>{{ r.value }}</strong> {{ r.note }}</span
              >
            </div>
          }
          @if (nodes() && r.nodes.length > 1) {
            <ul class="nodes" [attr.aria-label]="t('resources.perNode')">
              @for (n of r.nodes; track n.name) {
                <li [class]="'tone-' + n.tone" [class.problem]="n.problem">
                  <span class="name">{{ n.name }}</span>
                  <app-resource-bar
                    [resource]="n.bar"
                    [label]="r.label + ' ' + n.name"
                    [head]="false"
                    [legend]="false"
                    [compact]="true"
                  />
                  <span class="pct">
                    @if (n.problem) {
                      <ion-icon name="warning" aria-hidden="true" />
                    }
                    {{ n.pct }}
                  </span>
                </li>
              }
            </ul>
          }
        </section>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
    }
    .small {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.9rem 0.75rem;
      margin: 0 0 1.25rem;
    }
    @container (min-width: 26rem) {
      .small {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .small div {
      border-left: 2px solid var(--tone);
      padding-left: 0.6rem;
      min-width: 0;
    }
    .small dt {
      color: var(--mute);
      font-size: 0.75rem;
      line-height: 1.25;
      hyphens: auto;
      overflow-wrap: anywhere;
    }
    .small dd {
      margin: 0;
    }
    .value {
      font-size: 1.35rem;
      font-weight: 650;
      line-height: 1.2;
    }
    .note {
      color: var(--mute);
      font-size: 0.75rem;
      overflow-wrap: anywhere;
    }
    .res {
      padding: 0.9rem 0 0.4rem;
      border-top: 1px solid var(--line);
    }
    .plain {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.875rem;
    }
    .plain .label {
      color: var(--mute);
      font-weight: 600;
    }
    .nodes {
      list-style: none;
      margin: 0.6rem 0 0;
      padding: 0;
      display: grid;
      gap: 0.15rem;
    }
    .nodes li {
      display: grid;
      grid-template-columns: minmax(0, 7.5rem) minmax(0, 1fr) 3.4rem;
      gap: 0.6rem;
      align-items: center;
      font-size: 0.75rem;
    }
    .name {
      color: var(--ink-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pct {
      text-align: right;
      color: var(--ink-2);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .problem .name,
    .problem .pct {
      color: var(--tone);
      font-weight: 650;
    }
    .pct ion-icon {
      vertical-align: -0.15em;
      font-size: 0.85rem;
    }
  `,
})
export class ResourceRail {
  readonly rail = input.required<RailView>();
  /** The per-node rows under CPU and RAM. */
  readonly nodes = input(true);
}
