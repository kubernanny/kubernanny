import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ActionsService } from './actions/actions.service';
import { LocalizeExceptionFilter, LocalizeInterceptor } from './i18n/localize';
import { AppController } from './app.controller';
import { DevicesService } from './auth/devices.service';
import { IdentityService } from './auth/identity.service';
import { PrincipalGuard } from './auth/principal.guard';
import { CONFIG, Config, loadConfig } from './config';
import { E2eController } from './e2e/e2e.controller';
import { E2eService } from './e2e/e2e.service';
import { InternalServer } from './e2e/internal-server';
import { DemoKubeClient } from './demo/demo-cluster';
import { IncidentsService } from './incidents/incidents.service';
import { KubeClient } from './kube/kube-client';
import { Notifier } from './notify/notifier';
import { PairingService } from './pairing/pairing';
import { RelayClient } from './relay/relay-client';
import { SettingsService } from './settings/settings.service';
import { SilenceService } from './silence/silence.service';
import { StatusService } from './status/status.service';

@Module({
  controllers: [AppController, E2eController],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    // Texts leave the agent rendered in the request's language (docs/decisions/0006-agent-languages.md).
    { provide: APP_INTERCEPTOR, useClass: LocalizeInterceptor },
    { provide: APP_FILTER, useClass: LocalizeExceptionFilter },
    // DEMO=1 (or broken | warning | healthy): a built-in made-up cluster, for trying Kubernanny without one.
    { provide: KubeClient, useFactory: (config: Config) => (config.demo ? new DemoKubeClient(undefined, config.demo) : new KubeClient()), inject: [CONFIG] },
    IdentityService,
    DevicesService,
    InternalServer,
    E2eService,
    RelayClient,
    PairingService,
    SettingsService,
    SilenceService,
    IncidentsService,
    Notifier,
    StatusService,
    ActionsService,
    // Every route needs a device proven by the end-to-end channel, unless it is marked @Public() (fail closed).
    { provide: APP_GUARD, useClass: PrincipalGuard },
  ],
})
export class AppModule {}
