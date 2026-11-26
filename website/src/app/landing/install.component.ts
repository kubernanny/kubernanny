import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SITE } from '../../site.config';
import { CopyButtonComponent } from '../components/copy-button.component';
import { IconComponent } from '../components/icon.component';
import { qrModules } from './pseudo-qr';

@Component({
  selector: 'kn-install',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CopyButtonComponent, IconComponent],
  template: `
    <section id="install" class="container install" aria-labelledby="install-title">
      <div class="intro">
        <p class="eyebrow">Install</p>
        <h2 id="install-title">Running in a minute.</h2>
        <p class="sub">
          One Helm release in the cluster you want to watch. No account to create, no cloud in between, nothing to
          configure for the defaults.
        </p>
        <div class="other">
          <p>
            <strong>Other ways:</strong>
            <code
              >kubectl apply -f https://raw.githubusercontent.com/kubernanny/kubernanny/v0.3.1/deploy/install.yaml</code
            >, or an Argo CD Application.
          </p>
          <p>
            <strong>No ingress?</strong> Port-forward the service: the agent serves the full web UI itself.
            <a routerLink="/docs/configuration">Configuration</a>
          </p>
        </div>
      </div>

      <ol class="steps">
        <li class="step">
          <span class="num" aria-hidden="true">1</span>
          <div class="body">
            <h3>Install the chart</h3>
            <div class="term">
              <div class="term-head">
                <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <kn-copy-button [text]="vm.helm" what="the Helm install command" />
              </div>
              <pre><code>@for (line of vm.helmLines; track $index) {<span class="line" [class.cont]="!$first">@if ($first) {<span class="prompt" aria-hidden="true">$ </span>}{{ line }}</span>}</code></pre>
            </div>
          </div>
        </li>
        <li class="step">
          <span class="num" aria-hidden="true">2</span>
          <div class="body">
            <h3>Read its log</h3>
            <div class="term">
              <div class="term-head">
                <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <kn-copy-button [text]="vm.logs" what="the logs command" />
              </div>
              <pre><code><span class="prompt" aria-hidden="true">$ </span>{{ vm.logs }}</code></pre>
            </div>
            <p class="note">
              It prints a QR code, a one-time pairing code (valid for an hour) and the agent's public key.
            </p>
          </div>
        </li>
        <li class="step">
          <span class="num" aria-hidden="true">3</span>
          <div class="body scan">
            <div>
              <h3>Scan the QR code</h3>
              <p class="note">
                With your phone's camera, or open the link in a browser. Your device creates its own key pair, which
                never leaves it. That's the whole setup.
              </p>
            </div>
            <svg class="qr" viewBox="0 0 25 25" aria-hidden="true" shape-rendering="crispEdges">
              @for (m of vm.qr; track $index) {
                <rect [attr.x]="m.x" [attr.y]="m.y" width="1" height="1" />
              }
            </svg>
          </div>
        </li>
      </ol>

      <div class="try">
        <kn-icon name="terminal" />
        <p><strong>Just looking?</strong> Run the agent with a demo cluster on your laptop:</p>
        <div class="try-cmd">
          <code>{{ vm.demo }}</code>
          <kn-copy-button [text]="vm.demo" what="the demo command" />
        </div>
      </div>
    </section>
  `,
  styleUrl: './install.component.css',
})
export class InstallComponent {
  protected readonly vm = {
    helm: SITE.install.helm,
    // Shown over three lines; the copy button copies the one-line command.
    helmLines: [
      'helm install kubernanny \\',
      'oci://ghcr.io/kubernanny/charts/kubernanny \\',
      '-n kubernanny --create-namespace',
    ],
    logs: SITE.install.logs,
    demo: SITE.install.demo,
    qr: qrModules(),
  };
}
