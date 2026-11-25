/**
 * Build-time switches. `demo.ts` replaces this file in the `demo` build
 * configuration (angular.json), which is what demo.kubernanny.app serves.
 */

/**
 * The public demo host: only the built-in demo clusters, no pairing, no
 * adding, no call to any agent. Decided when building, never from the page's
 * address: an agent someone serves at demo.example.com is a normal agent.
 */
export const DEMO_HOST = false;
