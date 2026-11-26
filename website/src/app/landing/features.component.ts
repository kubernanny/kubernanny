import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { componentGroups } from 'virtual:kubernanny-components';
import { SITE } from '../../site.config';
import { IconComponent } from '../components/icon.component';
import { SCREENSHOTS } from './screenshots';

const COMPONENTS = componentGroups.flatMap((g) => g.components);

/** Illustrative switches; the module ids are real (docs/CONFIGURATION.md). */
const SWITCHES = [
  { label: 'Argo CD', on: true },
  { label: 'Longhorn', on: true },
  { label: 'Loki', on: false },
  { label: 'Restart workloads', on: true },
  { label: 'Notifications', on: true },
];

const CHANNELS = ['ntfy', 'Discord', 'Slack', 'Gotify', 'JSON webhook'];

@Component({
  selector: 'kn-features',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <section id="features" class="container features" aria-labelledby="features-title">
      <header class="head">
        <p class="eyebrow">What it does</p>
        <h2 id="features-title">Knows your stack. Says only what matters.</h2>
        <p class="sub">
          Not another cluster browser: k9s and Lens are great for exploring. Kubernanny is for the moment your phone
          buzzes at 04:10, and for the glance before bed.
        </p>
      </header>

      <div class="bento">
        <article class="card discover">
          <div class="card-text">
            <span class="badge"><kn-icon name="radar" /></span>
            <h3>Recognises {{ vm.count }} components by their images</h3>
            <p>
              Longhorn, Argo CD, cert-manager, CloudNativePG, Prometheus, Loki, kured and the rest: found by the
              container images of their workloads, whichever chart, operator or namespace installed them.
            </p>
          </div>
          <ul class="cloud" aria-label="Recognised components">
            @for (c of vm.components; track c.name) {
              <li [class.deep]="c.deep">{{ c.name }}</li>
            }
          </ul>
          <p class="legend">
            <span class="deep-dot" aria-hidden="true"></span> deep check
            <a routerLink="/docs/components">All components <kn-icon name="arrowRight" /></a>
          </p>
        </article>

        <article class="card shot-card checks">
          <div class="card-text">
            <span class="badge"><kn-icon name="stethoscope" /></span>
            <h3>Deep checks, not just pod status</h3>
            <p>
              Degraded Longhorn volumes, Argo CD apps with the broken resource, CNPG backup age, expiring
              certificates. Plus the community mixins' standard alerts, built in: etcd peer latency, disks filling up,
              overcommit, CoreDNS.
              <a routerLink="/docs/checks">Every check</a>
            </p>
          </div>
          <div class="shot">
            <img [src]="vm.longhorn.src" [alt]="vm.longhorn.alt" [width]="vm.longhorn.width" [height]="vm.longhorn.height" loading="lazy" decoding="async" />
          </div>
        </article>

        <article class="card shot-card broken">
          <div class="card-text">
            <span class="badge crit"><kn-icon name="scan" /></span>
            <h3>Only what is broken</h3>
            <p>No wall of green. Each problem says why, since when, and which action usually fixes it. A planned kured reboot is a warning; an Argo CD app waiting for its sync is a calm "ready to sync" note.</p>
          </div>
          <div class="shot">
            <img [src]="vm.issues.src" [alt]="vm.issues.alt" [width]="vm.issues.width" [height]="vm.issues.height" loading="lazy" decoding="async" />
          </div>
        </article>

        <article class="card shot-card actions">
          <div class="card-text">
            <span class="badge"><kn-icon name="wrench" /></span>
            <h3>Actions bound to issues</h3>
            <p>
              Restart, back up now, reconcile, renew, uncordon, clean up: offered only on an open problem, always
              confirmed first, with what exactly happens. A crash loop shows its logs first; after an OOMKill there is
              no restart button. The agent takes the target from its own check, never from the request.
            </p>
          </div>
          <div class="shot">
            <img [src]="vm.confirm.src" [alt]="vm.confirm.alt" [width]="vm.confirm.width" [height]="vm.confirm.height" loading="lazy" decoding="async" />
          </div>
        </article>

        <article class="card crypto">
          <span class="badge"><kn-icon name="key" /></span>
          <h3>End-to-end encrypted, on any path</h3>
          <p>
            Every call is a fresh Noise IK handshake between your device's own key and the agent's pinned key. VPN,
            LAN or plain HTTP: the path stops mattering.
          </p>
          <div class="handshake" aria-hidden="true">
            <span class="node">device key</span>
            <span class="wire"><i></i></span>
            <span class="node">agent key</span>
          </div>
          <a routerLink="/docs/protocol" class="more">Read the protocol <kn-icon name="arrowRight" /></a>
        </article>

        <article class="card switches">
          <span class="badge"><kn-icon name="toggle" /></span>
          <h3>A switch for every module</h3>
          <p>
            Every check, action and connection switches off on its own. In the app it pauses; in Helm it is gone: no
            permission, no route, no connection.
          </p>
          <ul class="toggles" aria-hidden="true">
            @for (s of vm.switches; track s.label) {
              <li><span>{{ s.label }}</span><i [class.on]="s.on"></i></li>
            }
          </ul>
          <a href="#switches-title" class="more">What off removes <kn-icon name="arrowRight" /></a>
        </article>

        <article class="card relay">
          <span class="badge"><kn-icon name="relay" /></span>
          <h3>Reachable without a VPN</h3>
          <p>
            Switch on the relay and the agent dials out, no open port. The relay only passes sealed messages along: it
            can read none of them. Run your own, or use ours.
          </p>
          <a routerLink="/docs/relay" class="more">What the relay sees <kn-icon name="arrowRight" /></a>
        </article>

        <article class="card security">
          <span class="badge"><kn-icon name="shield" /></span>
          <h3>Security hints and known vulnerabilities</h3>
          <p>
            Privileged containers, host access, missing limits. And, if you switch it on, the versions you run checked
            against OSV.dev, with the release that fixes them. The built-in lookup covers Kubernetes and well-known
            components only; every image, your own included, is covered when Trivy Operator runs in the cluster.
          </p>
          <a routerLink="/docs/security-checks" class="more">Security checks <kn-icon name="arrowRight" /></a>
        </article>

        <article class="card calm">
          <span class="badge"><kn-icon name="clock" /></span>
          <h3>Calm for the long run</h3>
          <p>
            Silence a known problem for an hour or a week. Look back at every incident, check your backups at a glance,
            and get a weekly digest if you like.
          </p>
          <a routerLink="/docs/notifications" class="more">Notifications <kn-icon name="arrowRight" /></a>
        </article>

        <article class="card notify">
          <span class="badge"><kn-icon name="bell" /></span>
          <h3>Notifications that wait five minutes</h3>
          <p>
            A problem is sent once it has lasted five minutes, so rollouts and planned reboots never wake you. Again if
            it turns critical, and once more when it is resolved. Straight to the app as a native push, sealed for your
            device so neither the relay nor Google can read it, and the home-screen widget updates with it. Or to
            your own channels:
          </p>
          <ul class="channels" aria-label="Channels">
            @for (c of vm.channels; track c) {
              <li>{{ c }}</li>
            }
          </ul>
          <ol class="timeline" aria-label="When a message is sent">
            <li><span class="t">0 min</span><span class="dot warn"></span>Problem appears</li>
            <li><span class="t">5 min</span><span class="dot warn"></span>Sent, if still there</li>
            <li><span class="t">later</span><span class="dot crit"></span>Turns critical: sent again</li>
            <li><span class="t">fixed</span><span class="dot ok"></span>Resolved: one last message</li>
          </ol>
        </article>

        <article class="card free">
          <span class="badge ok"><kn-icon name="heart" /></span>
          <h3>Open source, free, and staying that way</h3>
          <p>
            {{ vm.licence }}. No account, no backend of ours, no telemetry, no pro tier, no checks behind a paywall.
            Nothing leaves your network unless you switch it on: notifications, the relay, the vulnerability lookup.
          </p>
          <a [href]="vm.repoUrl" class="more"><kn-icon name="github" /> Source on GitHub</a>
        </article>
      </div>
    </section>
  `,
  styleUrl: './features.component.css',
})
export class FeaturesComponent {
  protected readonly vm = {
    count: COMPONENTS.length,
    components: COMPONENTS,
    longhorn: SCREENSHOTS.longhorn,
    issues: SCREENSHOTS.issues,
    confirm: SCREENSHOTS.confirm,
    switches: SWITCHES,
    channels: CHANNELS,
    licence: SITE.licence,
    repoUrl: SITE.repoUrl,
  };
}
