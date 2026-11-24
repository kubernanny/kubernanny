import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { docNav } from 'virtual:kubernanny-docs';
import { SITE } from '../../site.config';
import { IconComponent } from '../components/icon.component';

// Decision records sit under "Decisions" in the sidebar.
const NAV = docNav.map((group) => ({
  title: group.title,
  items: group.items.map((item) => ({ ...item, nested: /^decisions\/\d/.test(item.file) })),
}));

/** Layout for every `/docs/...` page: sidebar plus the page. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgTemplateOutlet, IconComponent],
  template: `
    <div class="docs container">
      <aside class="sidebar" aria-label="Documentation">
        <details class="mobile-nav" [open]="menuOpen()" (toggle)="onToggle($event)">
          <summary>
            <kn-icon name="book" />
            Browse the docs
          </summary>
          <ng-container *ngTemplateOutlet="navList" />
        </details>
        <div class="desktop-nav">
          <ng-container *ngTemplateOutlet="navList" />
        </div>
      </aside>
      <div class="page">
        <router-outlet />
      </div>
    </div>

    <ng-template #navList>
      <nav class="nav" aria-label="Documentation pages">
        @for (group of nav; track group.title) {
          <div class="group">
            <p class="group-title">{{ group.title }}</p>
            <ul>
              @for (item of group.items; track item.route) {
                <li [class.nested]="item.nested">
                  <a
                    [routerLink]="item.route"
                    routerLinkActive="active"
                    [routerLinkActiveOptions]="{ exact: true }"
                    ariaCurrentWhenActive="page"
                    >{{ item.label }}</a
                  >
                </li>
              }
            </ul>
          </div>
        }
        <a class="repo" [href]="repoUrl + '/tree/main/docs'">
          <kn-icon name="github" />
          docs/ on GitHub
        </a>
      </nav>
    </ng-template>
  `,
  styles: `
    .docs {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 24px;
      padding-top: 24px;
      padding-bottom: 32px;
    }
    @media (min-width: 960px) {
      .docs {
        grid-template-columns: 232px minmax(0, 1fr);
        gap: 56px;
        padding-top: 48px;
      }
    }
    .page {
      min-width: 0;
    }
    .desktop-nav {
      display: none;
    }
    @media (min-width: 960px) {
      .mobile-nav {
        display: none;
      }
      .desktop-nav {
        display: block;
        position: sticky;
        top: calc(var(--header-h) + 32px);
        max-height: calc(100vh - var(--header-h) - 48px);
        overflow-y: auto;
        padding-bottom: 24px;
        scrollbar-width: thin;
      }
    }
    .mobile-nav {
      border: 1px solid var(--line);
      border-radius: var(--radius-m);
      background: var(--surface);
    }
    .mobile-nav summary {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      font-weight: 650;
      cursor: pointer;
      color: var(--ink);
    }
    .mobile-nav .nav {
      padding: 4px 16px 16px;
    }
    .group + .group {
      margin-top: 22px;
    }
    .group-title {
      margin: 0 0 8px;
      font: 700 0.75rem/1 var(--font-body);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--mute);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li a {
      display: block;
      padding: 6px 10px;
      margin-left: -10px;
      border-radius: var(--radius-s);
      color: var(--ink-2);
      text-decoration: none;
      font-size: 0.9375rem;
      line-height: 1.35;
    }
    li.nested a {
      padding-left: 22px;
      font-size: 0.875rem;
      color: var(--mute);
    }
    li a:hover {
      color: var(--ink);
      background: var(--raise);
    }
    li a.active {
      color: var(--ink);
      background: var(--accent-soft);
      box-shadow: inset 2px 0 0 var(--accent);
      font-weight: 650;
    }
    .repo {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 28px;
      font-size: 0.875rem;
      color: var(--mute);
      text-decoration: none;
    }
    .repo:hover {
      color: var(--ink);
    }
  `,
})
export default class DocsLayoutPage {
  protected readonly nav = NAV;
  protected readonly repoUrl = SITE.repoUrl;
  protected readonly menuOpen = signal(false);

  constructor() {
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  protected onToggle(event: Event): void {
    this.menuOpen.set((event.target as HTMLDetailsElement).open);
  }
}
