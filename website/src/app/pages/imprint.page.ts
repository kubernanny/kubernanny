import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LEGAL, SITE, isPlaceholder } from '../../site.config';
import { SeoService } from '../core/seo.service';

function field(value: string) {
  return { value, todo: isPlaceholder(value) };
}

const VM = {
  name: field(LEGAL.name),
  street: field(LEGAL.street),
  city: field(LEGAL.city),
  country: LEGAL.country,
  email: field(LEGAL.email),
  phone: field(LEGAL.phone),
  responsible: field(LEGAL.responsibleForContent),
  draft: Object.values(LEGAL).some(isPlaceholder),
  repoUrl: SITE.repoUrl,
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container legal prose">
      <h1>Imprint <span lang="de">(Impressum)</span></h1>
      @if (vm.draft) {
        <p class="draft" role="note">Draft: the details below are placeholders and still have to be filled in.</p>
      }

      <h2>Provider <span lang="de">(Angaben gemäß § 5 DDG)</span></h2>
      <address>
        <span [class.todo]="vm.name.todo">{{ vm.name.value }}</span><br />
        <span [class.todo]="vm.street.todo">{{ vm.street.value }}</span><br />
        <span [class.todo]="vm.city.todo">{{ vm.city.value }}</span><br />
        {{ vm.country }}
      </address>

      <h2>Contact</h2>
      <p>
        E-mail: <span [class.todo]="vm.email.todo">{{ vm.email.value }}</span><br />
        Phone: <span [class.todo]="vm.phone.todo">{{ vm.phone.value }}</span>
      </p>

      <h2>Responsible for the content <span lang="de">(§ 18 Abs. 2 MStV)</span></h2>
      <p><span [class.todo]="vm.responsible.todo">{{ vm.responsible.value }}</span></p>

      <h2>About this project</h2>
      <p>
        Kubernanny is a non-commercial open-source project. Bugs and questions about the software are best raised as
        an issue on <a [href]="vm.repoUrl + '/issues'">GitHub</a>; security problems through the process in
        <a [href]="vm.repoUrl + '/blob/main/SECURITY.md'">SECURITY.md</a>.
      </p>

      <h2>Liability for links</h2>
      <p>
        This site links to external websites, such as GitHub. Their content is the responsibility of their operators.
        If a linked page turns out to be unlawful, the link will be removed as soon as that becomes known.
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
