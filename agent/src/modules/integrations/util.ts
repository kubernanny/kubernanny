import { Condition } from '../../checks/types';

export interface Conditioned {
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; creationTimestamp?: string };
  status?: { conditions?: Condition[] };
}
