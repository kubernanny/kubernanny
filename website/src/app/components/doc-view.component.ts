import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { copyText } from '../core/clipboard';
import type { DocPage } from '../core/docs.types';
import { renderMermaid } from '../core/mermaid';
import { SeoService } from '../core/seo.service';
import { IconComponent } from './icon.component';

@Component({
  selector: 'kn-doc-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    @let page = doc();
    <div class="doc-grid" [class.no-toc]="!vm().hasToc">
      <article>
        <p class="crumbs">
          <a routerLink="/docs">Docs</a>
          @if (page.section) {
            <span aria-hidden="true">/</span><span>{{ page.section }}</span>
          }
        </p>

        @if (vm().hasToc) {
          <details class="toc-inline">
            <summary>On this page</summary>
            <ul>
              @for (entry of page.toc; track entry.id) {
                <li [class.sub]="entry.level === 3">
                  <a [routerLink]="page.route" [fragment]="entry.id">{{ entry.text }}</a>
                </li>
              }
            </ul>
          </details>
        }

        <div class="prose" [innerHTML]="html()" (click)="onContentClick($event)"></div>

        <footer class="doc-foot">
          <a class="edit" [href]="page.editUrl">
            <kn-icon name="code" />
            Edit this page on GitHub
          </a>
          @if (page.prev || page.next) {
            <nav class="pager" aria-label="Previous and next page">
              @if (page.prev; as prev) {
                <a class="prev" [routerLink]="prev.route">
                  <span class="dir">Previous</span>
                  <span class="label">{{ prev.label }}</span>
                </a>
              } @else {
                <span></span>
              }
              @if (page.next; as next) {
                <a class="next" [routerLink]="next.route">
                  <span class="dir">Next</span>
                  <span class="label">{{ next.label }}</span>
                </a>
              }
            </nav>
          }
        </footer>
      </article>

      @if (vm().hasToc) {
        <aside class="toc" aria-labelledby="toc-title">
          <p id="toc-title" class="toc-title">On this page</p>
          <ul>
            @for (entry of page.toc; track entry.id) {
              <li [class.sub]="entry.level === 3">
                <a
                  [routerLink]="page.route"
                  [fragment]="entry.id"
                  [class.active]="entry.id === activeId()"
                  [attr.aria-current]="entry.id === activeId() ? 'location' : null"
                  >{{ entry.text }}</a
                >
              </li>
            }
          </ul>
        </aside>
      }
    </div>
  `,
  styleUrl: './doc-view.component.css',
})
export class DocViewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly seo = inject(SeoService);

  protected readonly doc = toSignal(this.route.data.pipe(map((d) => d['doc'] as DocPage)), { requireSync: true });
  // Built from the repository's own docs at build time; raw HTML in them passed an allowlist there (build/raw-html.ts).
  protected readonly html = computed(() => this.sanitizer.bypassSecurityTrustHtml(this.doc().html));
  protected readonly vm = computed(() => ({ hasToc: this.doc().toc.length > 1 }));
  protected readonly activeId = signal<string | null>(null);

  constructor() {
    this.route.data.pipe(takeUntilDestroyed()).subscribe((data) => {
      const page = data['doc'] as DocPage;
      this.seo.set({
        title: page.title,
        description: page.description || `${page.title}: Kubernanny documentation.`,
        path: page.route,
        type: 'article',
      });
    });

    let stopSpy: (() => void) | undefined;
    inject(DestroyRef).onDestroy(() => stopSpy?.());

    afterRenderEffect(() => {
      const page = this.doc();
      const root = this.host.nativeElement.querySelector<HTMLElement>('.prose');
      if (!root) {
        return;
      }
      if (page.hasMermaid) {
        void renderMermaid(root);
      }
      stopSpy?.();
      stopSpy = this.spy(root);
    });
  }

  /** Highlights the section being read: the last heading scrolled past the header. */
  private spy(root: HTMLElement): () => void {
    const headings = [...root.querySelectorAll<HTMLElement>('h2[id], h3[id]')];
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | null = headings[0]?.id ?? null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top - 120 > 0) {
          break;
        }
        current = h.id;
      }
      this.activeId.set(current);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }

  /** Copy buttons and in-site links inside the pre-rendered HTML. */
  protected onContentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-copy]');
    if (button) {
      const code = button.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
      void copyText(code).then((ok) => {
        if (ok) {
          button.textContent = 'Copied';
          button.setAttribute('data-copied', '');
          setTimeout(() => {
            button.textContent = 'Copy';
            button.removeAttribute('data-copied');
          }, 1800);
        }
      });
      return;
    }
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    const href = link?.getAttribute('href') ?? '';
    const plainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (link && plainClick && !link.target && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/docs-media/')) {
      event.preventDefault();
      void this.router.navigateByUrl(href);
    }
  }
}
