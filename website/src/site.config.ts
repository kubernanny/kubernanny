/**
 * Everything about the site that is not documentation: names, links, and the
 * legal details for the imprint and the privacy notice.
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
  sponsorsUrl: 'https://github.com/sponsors/NLueg',
  kofiUrl: 'https://ko-fi.com/nicolueg',
  /** The maintainer, credited in the footer. */
  author: { name: 'Nico Lueg', url: 'https://nicolueg.com', github: 'https://github.com/NLueg' },
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
 * The same details as the maintainer's imprint on nicolueg.com: the e-mail
 * address is the fast electronic contact, there is no phone line.
 */
export const LEGAL = {
  name: 'Nico Lueg',
  street: 'Peukinger Weg 17',
  city: '59423 Unna',
  country: 'Germany',
  email: 'info@nicolueg.com',
  /** Umsatzsteuer-Identifikationsnummer (§ 27a UStG). */
  vatId: 'DE366320011',
} as const;
