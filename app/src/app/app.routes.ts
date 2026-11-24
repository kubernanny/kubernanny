import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { ClusterStore } from './core/cluster-store.service';

/** With exactly one cluster the app opens straight into it. */
export const startRedirect: CanActivateFn = async () => {
  const store = inject(ClusterStore);
  const router = inject(Router);
  await store.loaded;
  if (store.clusters().length === 0 && location.hostname.startsWith('demo.')) {
    await store.addDemo();
  }
  const list = store.clusters();
  return list.length === 1 ? router.createUrlTree(['/c', list[0].id]) : router.createUrlTree(['/clusters']);
};

/** demo.kubernanny.app and /#/demo: the built-in demo, without pairing anything. */
export const startDemo: CanActivateFn = async () => {
  // inject() only works before the first await.
  const store = inject(ClusterStore);
  const router = inject(Router);
  await store.addDemo();
  return router.createUrlTree(['/clusters']);
};

// Titles are translation keys, see TranslatedTitleStrategy.
export const routes: Routes = [
  { path: 'demo', canActivate: [startDemo], children: [] },
  { path: '', pathMatch: 'full', canActivate: [startRedirect], children: [] },
  { path: 'clusters', title: 'app.titles.clusters', loadComponent: () => import('./clusters/clusters.page').then((m) => m.ClustersPage) },
  { path: 'c/:id', title: 'app.titles.cluster', loadComponent: () => import('./cluster/cluster.page').then((m) => m.ClusterPage) },
  { path: 'pair', title: 'app.titles.pair', loadComponent: () => import('./pair/pair.page').then((m) => m.PairPage) },
  { path: 'cluster/new', title: 'app.titles.newCluster', loadComponent: () => import('./cluster-form/cluster-form.page').then((m) => m.ClusterFormPage) },
  { path: 'cluster/:id/modules', title: 'app.titles.modules', loadComponent: () => import('./modules-settings/modules-settings.page').then((m) => m.ModulesSettingsPage) },
  { path: 'cluster/:id', title: 'app.titles.settings', loadComponent: () => import('./cluster-form/cluster-form.page').then((m) => m.ClusterFormPage) },
  { path: '**', redirectTo: '' },
];
