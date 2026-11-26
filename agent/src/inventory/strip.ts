/**
 * What the watch caches keep of each object: only the fields the checks,
 * discovery and the views read. Everything else (managedFields, the
 * last-applied annotation, env, probes, node image lists, …) is dropped
 * before an object is stored, so the agent's memory grows with the number of
 * objects, not with how verbose they are. A check that starts reading a new
 * field must add it here; `strip.spec.ts` runs every check on stripped demo
 * objects and compares the result with the unstripped run.
 */

type Obj = Record<string, unknown>;

/** The annotations anything in the agent reads. */
const KEPT_ANNOTATIONS = [
  'kubernetes.io/ingress.class',
  'storageclass.kubernetes.io/is-default-class',
  'weave.works/kured-node-lock',
  'kubernanny.io/accept',
] as const;

/** The security hints a workload accepts (modules/security/accept-annotation.ts), also kept on pod templates. */
const ACCEPT = 'kubernanny.io/accept';

/** Longest event message kept (a stuck pod's scheduler message can be long). */
const MAX_EVENT_MESSAGE = 1024;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(o: unknown, keys: readonly string[]): Obj | undefined {
  if (!isObj(o)) {
    return undefined;
  }
  const out: Obj = {};
  for (const k of keys) {
    if (o[k] !== undefined) {
      out[k] = o[k];
    }
  }
  return out;
}

function stripMeta(meta: unknown): Obj {
  const m = isObj(meta) ? meta : {};
  const out = pick(m, [
    'name',
    'namespace',
    'uid',
    'resourceVersion',
    'generation',
    'creationTimestamp',
    'deletionTimestamp',
    'labels',
    'ownerReferences',
  ])!;
  if (isObj(m.annotations)) {
    const kept: Record<string, unknown> = {};
    for (const key of KEPT_ANNOTATIONS) {
      if (m.annotations[key] !== undefined) {
        kept[key] = m.annotations[key];
      }
    }
    if (Object.keys(kept).length) {
      out.annotations = kept;
    }
  }
  if (Array.isArray(out.ownerReferences)) {
    out.ownerReferences = (out.ownerReferences as unknown[]).map((r) =>
      pick(r, ['kind', 'name', 'apiVersion', 'uid', 'controller']),
    );
  }
  return out;
}

const CONTAINER_KEYS = ['name', 'image', 'resources', 'securityContext', 'ports'] as const;

/**
 * Only the ConfigMaps a container reads into its environment, by name (the
 * restart offer asks whether one changed after the start). Literal values
 * and Secret references are dropped.
 */
function envRefs(c: Obj, out: Obj): void {
  if (Array.isArray(c.envFrom)) {
    const refs = c.envFrom
      .filter((e) => isObj(e) && isObj(e.configMapRef))
      .map((e) => ({ configMapRef: pick((e as Obj).configMapRef, ['name']) }));
    if (refs.length) {
      out.envFrom = refs;
    }
  }
  if (Array.isArray(c.env)) {
    const refs = c.env
      .filter((e) => isObj(e) && isObj(e.valueFrom) && isObj(e.valueFrom.configMapKeyRef))
      .map((e) => ({
        name: (e as Obj).name,
        valueFrom: { configMapKeyRef: pick(((e as Obj).valueFrom as Obj).configMapKeyRef, ['name']) },
      }));
    if (refs.length) {
      out.env = refs;
    }
  }
}

function stripContainers(list: unknown): unknown {
  return Array.isArray(list)
    ? list.map((c) => {
        const out = pick(c, CONTAINER_KEYS);
        if (out && isObj(c)) {
          envRefs(c, out);
        }
        return out;
      })
    : undefined;
}

/** A pod spec as the checks read it: containers' image, resources and security context, volumes by claim or host path, host namespaces. */
function stripPodSpec(spec: unknown): Obj | undefined {
  if (!isObj(spec)) {
    return undefined;
  }
  const out = pick(spec, [
    'nodeName',
    'hostNetwork',
    'hostPID',
    'hostIPC',
    'securityContext',
    'serviceAccountName',
    'priorityClassName',
  ])!;
  out.containers = stripContainers(spec.containers);
  if (spec.initContainers !== undefined) {
    out.initContainers = stripContainers(spec.initContainers);
  }
  if (Array.isArray(spec.volumes)) {
    out.volumes = spec.volumes.map((v) => pick(v, ['name', 'persistentVolumeClaim', 'hostPath']));
  }
  return out;
}

function stripTemplate(template: unknown): Obj | undefined {
  if (!isObj(template)) {
    return undefined;
  }
  const metadata = pick(template.metadata, ['labels']);
  const annotations = isObj(template.metadata) ? template.metadata.annotations : undefined;
  if (metadata && isObj(annotations) && typeof annotations[ACCEPT] === 'string') {
    metadata.annotations = { [ACCEPT]: annotations[ACCEPT] };
  }
  return { metadata, spec: stripPodSpec(template.spec) };
}

export function stripPod(o: unknown): Obj {
  const p = o as Obj;
  return { metadata: stripMeta(p.metadata), spec: stripPodSpec(p.spec), status: p.status };
}

export function stripNode(o: unknown): Obj {
  const n = o as Obj;
  const status = isObj(n.status) ? { ...n.status } : undefined;
  if (status) {
    // Every image on the node with its size: by far the largest part of a node object, read by nothing.
    delete status.images;
    delete status.volumesAttached;
  }
  const metadata = stripMeta(n.metadata);
  // When the node was cordoned: only the managedFields entries that own spec.unschedulable, without their field lists.
  const meta = isObj(n.metadata) ? n.metadata : {};
  if (Array.isArray(meta.managedFields)) {
    const owners = meta.managedFields.filter(
      (m) =>
        isObj(m) &&
        isObj(m.fieldsV1) &&
        isObj((m.fieldsV1 as Obj)['f:spec']) &&
        ((m.fieldsV1 as Obj)['f:spec'] as Obj)['f:unschedulable'] !== undefined,
    );
    if (owners.length) {
      metadata.managedFields = owners.map((m) => pick(m, ['manager', 'operation', 'time']));
    }
  }
  return { metadata, spec: pick(n.spec, ['unschedulable', 'taints', 'podCIDR', 'providerID']), status };
}

/** Deployments, StatefulSets, DaemonSets. */
export function stripWorkload(o: unknown): Obj {
  const w = o as Obj;
  const spec = isObj(w.spec)
    ? pick(w.spec, [
        'replicas',
        'selector',
        'paused',
        'serviceName',
        'volumeClaimTemplates',
        'updateStrategy',
        'strategy',
      ])
    : undefined;
  if (spec && isObj(w.spec)) {
    spec.template = stripTemplate(w.spec.template);
    if (Array.isArray(spec.volumeClaimTemplates)) {
      spec.volumeClaimTemplates = spec.volumeClaimTemplates.map((t) => ({
        metadata: pick((t as Obj).metadata, ['name']),
        spec: (t as Obj).spec,
      }));
    }
  }
  return { metadata: stripMeta(w.metadata), spec, status: w.status };
}

export function stripJob(o: unknown): Obj {
  const j = o as Obj;
  return {
    metadata: stripMeta(j.metadata),
    spec: pick(j.spec, ['completions', 'parallelism', 'backoffLimit', 'suspend']),
    status: j.status,
  };
}

export function stripCronJob(o: unknown): Obj {
  const c = o as Obj;
  const spec = isObj(c.spec) ? pick(c.spec, ['schedule', 'suspend', 'timeZone', 'concurrencyPolicy']) : undefined;
  if (spec && isObj(c.spec) && isObj(c.spec.jobTemplate)) {
    spec.jobTemplate = { spec: { template: stripTemplate((c.spec.jobTemplate.spec as Obj | undefined)?.template) } };
  }
  return { metadata: stripMeta(c.metadata), spec, status: c.status };
}

export function stripService(o: unknown): Obj {
  const s = o as Obj;
  return {
    metadata: stripMeta(s.metadata),
    spec: pick(s.spec, ['type', 'selector', 'ports', 'clusterIP', 'externalName']),
    status: s.status,
  };
}

/** Ingresses, PVCs, StorageClasses, Namespaces: small already, only the metadata is trimmed. */
export function stripPlain(o: unknown): Obj {
  const x = o as Obj;
  return { ...x, metadata: stripMeta(x.metadata) };
}

export function stripEvent(o: unknown): Obj {
  const e = o as Obj;
  const out = pick(e, [
    'type',
    'reason',
    'message',
    'count',
    'lastTimestamp',
    'eventTime',
    'firstTimestamp',
    'involvedObject',
    'series',
  ])!;
  out.metadata = stripMeta(e.metadata);
  if (typeof out.message === 'string' && out.message.length > MAX_EVENT_MESSAGE) {
    out.message = `${out.message.slice(0, MAX_EVENT_MESSAGE)}…`;
  }
  if (isObj(out.involvedObject)) {
    out.involvedObject = pick(out.involvedObject, ['kind', 'name', 'namespace']);
  }
  return out;
}

/** When an event last happened, for the age cap. */
export function eventTime(e: {
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  series?: { lastObservedTime?: string };
  metadata: { creationTimestamp?: string };
}): number {
  const t =
    e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}
