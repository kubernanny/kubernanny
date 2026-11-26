import { Module } from '@nestjs/common';

import { AgentHub } from './agent-hub.service';
import { loadConfig, RELAY_CONFIG } from './config';
import { RelayMetrics } from './metrics';
import { RelayController } from './relay.controller';

@Module({
  controllers: [RelayController],
  providers: [{ provide: RELAY_CONFIG, useFactory: () => loadConfig() }, AgentHub, RelayMetrics],
})
export class RelayModule {}
