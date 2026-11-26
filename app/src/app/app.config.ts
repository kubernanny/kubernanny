import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';

import { routes } from './app.routes';
import { provideI18n } from './i18n/provide-i18n';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // Hash routes: the agent serves the web UI as plain static files, no fallback needed.
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideIonicAngular({}),
    provideI18n(),
  ],
};
