/**
 * Everything about the site that is not documentation: names, links, and the
 * legal details for the imprint. Values starting with `TODO` are placeholders
 * the maintainer fills in before the site goes public (see README.md); the
 * imprint and privacy pages show them highlighted and print a warning banner
 * while any are left.
 */
export const SITE = {
  name: 'Kubernanny',
  url: 'https://kubernanny.app',
  title: 'Kubernanny: one light for your Kubernetes cluster',
  pitch: "Your cluster's nanny: one light, and only what is broken, with the cause and the fix.",
  description:
    'Open-source Kubernetes health for self-hosters. Recognises ~75 components, checks them deeply, and shows only what is broken, with the cause and the fix. End-to-end encrypted.',
  repoUrl: 'https://github.com/kubernanny/kubernanny',
  demoUrl: 'https://demo.kubernanny.app',
  sponsorsUrl: 'https://github.com/sponsors/kubernanny',
  /** TODO: the Ko-fi page does not exist yet; replace once it does. */
  kofiUrl: 'https://ko-fi.com/kubernanny',
  licence: 'Apache-2.0',
  install: {
    helm: 'helm install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny -n kubernanny --create-namespace',
    logs: 'kubectl -n kubernanny logs deploy/kubernanny',
    demo: 'docker run --rm -p 8080:8080 -e DEMO=broken ghcr.io/kubernanny/agent',
  },
  ogImage: '/og.png',
} as const;

/**
 * Impressum (§ 5 DDG) and controller for the privacy notice (Art. 13 GDPR).
 * Do NOT ship placeholders: fill in real data, it must be correct and reachable.
 */
export const LEGAL = {
  name: 'TODO: full name of the person responsible',
  street: 'TODO: street and number (a summonable address, no PO box)',
  city: 'TODO: postcode and city',
  country: 'Germany',
  email: 'TODO: contact e-mail address',
  /** § 5 DDG asks for a second fast way of contact; a phone number is the usual one. */
  phone: 'TODO: phone number or another direct contact',
  /** Person responsible for editorial content (§ 18 Abs. 2 MStV), usually the same person. */
  responsibleForContent: 'TODO: name and address, if different from above',
} as const;

export function isPlaceholder(value: string): boolean {
  return value.startsWith('TODO');
}
