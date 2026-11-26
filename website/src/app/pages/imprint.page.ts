import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { LEGAL, SITE } from '../../site.config';
import { SeoService } from '../core/seo.service';

const VM = { ...LEGAL, repoUrl: SITE.repoUrl };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container legal prose">
      <h1>Imprint <span lang="de">(Impressum)</span></h1>

      <h2>Provider <span lang="de">(Angaben gemäß § 5 DDG)</span></h2>
      <address>
        {{ vm.name }}<br />
        {{ vm.street }}<br />
        {{ vm.city }}<br />
        {{ vm.country }}
      </address>

      <h2>Contact</h2>
      <p>
        E-mail: <a [href]="'mailto:' + vm.email">{{ vm.email }}</a>
      </p>

      <h2>VAT ID <span lang="de">(USt-IdNr. gemäß § 27a UStG)</span></h2>
      <p>{{ vm.vatId }}</p>

      <h2>About this project</h2>
      <p>
        Kubernanny is a non-commercial open-source project. Bugs and questions about the software are best raised as an
        issue on <a [href]="vm.repoUrl + '/issues'">GitHub</a>; security problems through the process in
        <a [href]="vm.repoUrl + '/blob/main/SECURITY.md'">SECURITY.md</a>.
      </p>

      <h2>Liability for links</h2>
      <p>
        This site links to external websites, such as GitHub. Their content is the responsibility of their operators. If
        a linked page turns out to be unlawful, the link will be removed as soon as that becomes known.
      </p>
    </div>
  `,
  styleUrl: '../components/legal-shell.css',
})
export default class ImprintPage {
  protected readonly vm = VM;

  constructor() {
    inject(SeoService).set({
      title: 'Imprint',
      description: 'Imprint (Impressum) of kubernanny.app.',
      path: '/imprint',
    });
  }
}
