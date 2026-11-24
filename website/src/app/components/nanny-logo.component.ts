import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The Kubernanny icon (branding/kubernanny-ok.svg) inline, so the traffic-light
 * eye can drift from ok to warning to critical and back. With reduced motion
 * it stays ok. One instance per page: the gradient ids are fixed.
 */
@Component({
  selector: 'kn-nanny-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.animated]': 'animated()' },
  template: `
    <svg viewBox="0 0 1024 1024" role="img" aria-label="The Kubernanny nanny, whose right eye is a traffic light">
      <defs>
        <linearGradient id="kn-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1d2b4d" />
          <stop offset="1" stop-color="#0f1626" />
        </linearGradient>
        <linearGradient id="kn-logo-peri" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#b3c0ff" />
          <stop offset="1" stop-color="#7b90f3" />
        </linearGradient>
        <radialGradient id="kn-logo-glow">
          <stop class="glow-stop" offset="0" stop-color="#36d6a8" stop-opacity="0.55" />
          <stop class="glow-stop" offset="1" stop-color="#36d6a8" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill="url(#kn-logo-bg)" />
      <circle cx="512" cy="262" r="92" fill="#6f84ea" />
      <path d="M452 236 Q512 196 572 236" fill="none" stroke="#b3c0ff" stroke-width="14" stroke-linecap="round" opacity=".7" />
      <polygon
        points="512.0,322.0 721.5,422.9 773.3,649.6 628.3,831.5 395.7,831.5 250.7,649.6 302.5,422.9"
        fill="url(#kn-logo-peri)"
        stroke="url(#kn-logo-peri)"
        stroke-width="64"
        stroke-linejoin="round"
      />
      <circle class="glow" cx="626" cy="590" r="150" fill="url(#kn-logo-glow)" />
      <ellipse cx="380" cy="690" rx="44" ry="26" fill="#ff8fa3" opacity=".35" />
      <ellipse cx="644" cy="690" rx="44" ry="26" fill="#ff8fa3" opacity=".35" />
      <circle cx="404" cy="590" r="82" fill="#eef1ff" stroke="#16213b" stroke-width="24" />
      <circle cx="620" cy="590" r="82" fill="#eef1ff" stroke="#16213b" stroke-width="24" />
      <path d="M486 584 Q512 568 538 584" fill="none" stroke="#16213b" stroke-width="22" stroke-linecap="round" />
      <circle class="pupil" cx="408" cy="596" r="30" fill="#16213b" />
      <circle class="light" cx="624" cy="596" r="34" fill="#36d6a8" />
      <circle cx="636" cy="584" r="9" fill="#fff" opacity=".8" />
      <path d="M452 738 Q512 782 572 738" fill="none" stroke="#16213b" stroke-width="24" stroke-linecap="round" />
    </svg>
  `,
  styles: `
    :host {
      display: block;
      aspect-ratio: 1;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    /* Mostly ok, a short warning, a shorter critical, back to ok: what a calm week looks like. */
    @keyframes light {
      0%, 58% { fill: #36d6a8; }
      64%, 74% { fill: #f5b83d; }
      79%, 86% { fill: #ff5d73; }
      92%, 100% { fill: #36d6a8; }
    }
    @keyframes glow {
      0%, 58% { stop-color: #36d6a8; }
      64%, 74% { stop-color: #f5b83d; }
      79%, 86% { stop-color: #ff5d73; }
      92%, 100% { stop-color: #36d6a8; }
    }
    @keyframes look {
      0%, 60% { transform: translate(0, 0); }
      66%, 86% { transform: translate(10px, -4px); }
      92%, 100% { transform: translate(0, 0); }
    }
    @media (prefers-reduced-motion: no-preference) {
      :host(.animated) .light { animation: light 14s ease-in-out infinite; }
      :host(.animated) .glow-stop { animation: glow 14s ease-in-out infinite; }
      :host(.animated) .pupil { animation: look 14s ease-in-out infinite; }
    }
  `,
})
export class NannyLogoComponent {
  readonly animated = input(true);
}
