/** Texts of the standard alerts (`modules/core/standard-alerts`), spread into the German catalog. No em or en dashes. */
const dec = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

export const standardAlertsDe = {
  'module.standardAlerts.name': 'Standard-Alarme',
  'module.standardAlerts.description':
    'Die allgemein gültigen Alarme der Community-Regelsätze (etcd, Nodes, Kubernetes, CoreDNS, Prometheus), eingebaut: ohne eigene Prometheus-Regeln.',
  'std.alsoAlertmanager': (p: { cause: string; alerts: string }) => `${p.cause} Alertmanager meldet das ebenfalls (${p.alerts}).`,

  'std.etcdPeerRtt.title': (p: { from: string; to: string; ms: number }) => `etcd ${p.from} → ${p.to}: Netzwerk-Laufzeit ${dec(p.ms)} ms`,
  'std.etcdPeerRtt.cause': (p: { from: string; to: string; ms: number; threshold: number }) =>
    `Die 99. Perzentile der Laufzeit von etcd auf ${p.from} zu ${p.to} liegt seit 10 Minuten über ${dec(p.threshold)} ms (mindestens ${dec(p.ms)} ms). ` +
    'etcd-Mitglieder schicken sich alle 100 ms einen Herzschlag und wählen nach 1 s ohne einen neuen Leader. Langsame Verbindungen bremsen jeden Schreibzugriff und führen zu Leaderwechseln und Zeitüberschreitungen am API-Server. ' +
    'Typische Ursachen: Mitglieder an verschiedenen Standorten oder hinter einem VPN, WLAN oder eine ausgelastete Leitung, eine volle Netzwerkkarte, ein überlasteter Node (CPU-Steal, Swap). ' +
    'Ping zwischen beiden Nodes prüfen und die etcd-Nodes ins selbe schnelle, kabelgebundene Netz stellen.',
  'std.etcdFsync.title': (p: { node: string; ms: number }) => `etcd auf ${p.node}: Platte langsam (fsync ${dec(p.ms)} ms)`,
  'std.etcdFsync.cause': (p: { ms: number }) =>
    `Die 99. Perzentile des WAL-fsync liegt seit 10 Minuten bei mindestens ${dec(p.ms)} ms; gesund sind unter 10 ms. etcd bestätigt jeden Schreibzugriff erst nach dem fsync, ab 1 s gehen Herzschläge verloren und Leaderwahlen beginnen. ` +
    'Meist liegt etcd auf einer langsamen oder geteilten Platte (SD-Karte, HDD, Netzwerkspeicher, Longhorn auf demselben Datenträger). etcd gehört auf eine eigene SSD.',
  'std.etcdCommit.title': (p: { node: string; ms: number }) => `etcd auf ${p.node}: Commits langsam (${dec(p.ms)} ms)`,
  'std.etcdCommit.cause': (p: { ms: number }) =>
    `Die 99. Perzentile der Backend-Commits liegt seit 10 Minuten bei mindestens ${dec(p.ms)} ms (Grenze 250 ms). Die Platte unter etcd ist zu langsam oder überlastet; etcd gehört auf eine eigene SSD.`,
  'std.etcdNoLeader.title': (p: { node: string }) => `etcd auf ${p.node} hat keinen Leader`,
  'std.etcdNoLeader.cause':
    'Dieses Mitglied sieht seit einer Minute keinen Leader und kann keine Anfragen bedienen. Meist ist es vom Netz der anderen getrennt oder seine Uhr, Platte oder CPU hängt. Logs des etcd-Pods und die Verbindung zu den anderen Mitgliedern prüfen.',
  'std.etcdLeaderChanges.title': (p: { n: number }) => `etcd wechselt oft den Leader (${p.n} in 15 min)`,
  'std.etcdLeaderChanges.cause':
    'Jeder Wechsel hält Schreibzugriffe kurz an. Häufige Wechsel kommen von langsamen Platten (fsync), Netzwerkproblemen zwischen den Mitgliedern oder überlasteten Nodes.',
  'std.etcdDbQuota.title': (p: { node: string; pct: number }) => `etcd-Datenbank auf ${p.node} zu ${dec(p.pct)} % voll`,
  'std.etcdDbQuota.cause':
    'Am Kontingent löst etcd den Alarm NOSPACE aus und nimmt keine Schreibzugriffe mehr an: der Cluster steht. etcd kompaktieren und defragmentieren, danach den Alarm aufheben, oder das Kontingent (--quota-backend-bytes) erhöhen.',
  'std.etcdDbGrowth.title': (p: { node: string }) => `etcd-Datenbank auf ${p.node} wächst zu schnell`,
  'std.etcdDbGrowth.cause':
    'Im Tempo der letzten 4 Stunden erreicht die Datenbank in 4 Stunden ihr Kontingent; dann nimmt etcd keine Schreibzugriffe mehr an. Meist schreibt ein Controller oder Operator in einer Schleife Objekte; die Events und die größten Ressourcentypen ansehen.',
  'std.etcdFragmentation.title': (p: { node: string; pct: number }) => `etcd-Datenbank auf ${p.node} zu ${dec(p.pct)} % leer`,
  'std.etcdFragmentation.cause':
    'Mehr als die Hälfte der Datei ist freigegebener Platz. Das schadet nicht, kostet aber Platz und verlängert Snapshots. Eine Defragmentierung (etcdctl defrag, ein Mitglied nach dem anderen) gibt ihn zurück.',

  'std.filesystem.title': (p: { node: string; mount: string; free: number }) => `${p.node}: ${p.mount} nur noch ${dec(p.free)} % frei`,
  'std.filesystem.fillingCause': (p: { hours: number }) =>
    `Im Tempo der letzten 6 Stunden ist das Dateisystem in ${p.hours} Stunden voll. Was dort schreibt (Logs, Images, Volumes), aufräumen oder die Platte vergrößern.`,
  'std.filesystem.fullCause': 'Fast voll: Programme, die dort schreiben, scheitern bald. Aufräumen oder die Platte vergrößern.',
  'std.inodes.title': (p: { node: string; mount: string; free: number }) => `${p.node}: ${p.mount} nur noch ${dec(p.free)} % Inodes frei`,
  'std.inodes.cause':
    'Ohne freie Inodes lassen sich keine Dateien mehr anlegen, auch wenn noch Platz frei ist. Meist viele kleine Dateien: alte Container-Images, Logs, Caches. Aufräumen, zum Beispiel crictl rmi --prune.',
  'std.conntrack.title': (p: { node: string; pct: number }) => `${p.node}: Verbindungstabelle zu ${dec(p.pct)} % voll`,
  'std.conntrack.cause':
    'Ist die conntrack-Tabelle voll, verwirft der Kernel neue Verbindungen (nf_conntrack: table full im Kernel-Log). Ursache sind sehr viele kurze Verbindungen; net.netfilter.nf_conntrack_max erhöhen oder den Verursacher finden.',
  'std.networkErrors.receiveTitle': (p: { node: string; device: string; pct: number }) => `${p.node}: ${dec(p.pct)} % Empfangsfehler auf ${p.device}`,
  'std.networkErrors.transmitTitle': (p: { node: string; device: string; pct: number }) => `${p.node}: ${dec(p.pct)} % Sendefehler auf ${p.device}`,
  'std.networkErrors.cause':
    'Seit einer Stunde ist mehr als jedes hundertste Paket fehlerhaft. Meist Hardware: Kabel, Stecker, Switch-Port oder die Netzwerkkarte, seltener ein Treiber. ip -s link auf dem Node zeigt die Zähler.',
  'std.fileDescriptors.title': (p: { node: string; pct: number }) => `${p.node}: ${dec(p.pct)} % der Datei-Handles belegt`,
  'std.fileDescriptors.cause': 'Am Limit können Prozesse keine Dateien und Sockets mehr öffnen. Den Verbraucher finden oder fs.file-max erhöhen.',
  'std.raidDegraded.title': (p: { node: string; device: string; n: number }) => `${p.node}: RAID ${p.device} läuft ohne ${p.n} Platte(n)`,
  'std.raidDegraded.cause':
    'Das Array arbeitet ohne Redundanz: fällt noch eine Platte aus, sind die Daten weg. Die defekte Platte tauschen und das Array neu aufbauen lassen (cat /proc/mdstat).',
  'std.raidDiskFailed.title': (p: { node: string; device: string }) => `${p.node}: Platte in RAID ${p.device} ausgefallen`,
  'std.raidDiskFailed.cause': 'mdadm hat eine Platte als defekt markiert. Tauschen, bevor die nächste ausfällt (cat /proc/mdstat, mdadm --detail).',

  'std.nodeFlapping.title': (p: { node: string; n: number }) => `Node ${p.node} wechselt ständig zwischen bereit und nicht bereit`,
  'std.nodeFlapping.cause':
    'Der Ready-Zustand hat sich in jeder der letzten 15-Minuten-Spannen mehr als zweimal geändert. Pods werden dabei verdrängt und neu verteilt. Meist hat der Node Netzwerkaussetzer, oder der Kubelet hängt (Speicher, Platte, Container-Runtime).',
  'std.pvInodes.title': (p: { pvc: string; free: number }) => `Volume ${p.pvc}: nur noch ${dec(p.free)} % Inodes frei`,
  'std.pvInodes.fullCause': 'Ohne freie Inodes kann die Anwendung keine Dateien mehr anlegen, auch wenn noch Platz frei ist.',
  'std.pvInodes.fillingCause': 'Im Tempo der letzten 6 Stunden gehen die Inodes in 4 Tagen aus; dann lassen sich keine Dateien mehr anlegen. Alte Dateien aufräumen oder das Volume vergrößern.',
  'std.pvErrors.title': (p: { pv: string; phase: string }) => `PersistentVolume ${p.pv}: ${p.phase}`,
  'std.pvErrors.failedCause':
    'Das Freigeben des Volumes nach dem Löschen seines Claims ist gescheitert; sein Speicher ist womöglich noch belegt. kubectl describe pv zeigt den Grund, danach das Volume im Speicher-System von Hand entfernen.',
  'std.pvErrors.pendingCause': 'Das Volume steht nicht zur Bindung bereit. kubectl describe pv zeigt, worauf es wartet.',
  'std.quotaExceeded.title': (p: { quota: string; resource: string; pct: number }) => `Quota ${p.quota}: ${p.resource} bei ${p.pct} %`,
  'std.quotaExceeded.cause': 'Der Namespace braucht mehr, als seine ResourceQuota erlaubt: neue Pods und Objekte werden abgelehnt. Quota anheben oder Verbrauch senken.',
  'std.clientCertificate.title': (p: { node: string; days: number }) => `Client-Zertifikat an ${p.node} läuft in ${p.days} Tagen ab`,
  'std.clientCertificate.cause':
    'Ein Client meldet sich mit einem Zertifikat an, das bald abläuft; danach wird er abgewiesen. Welcher, sagt die Metrik nicht: meist ein Kubelet, ein Controller oder eine kubeconfig. RKE2 und k3s erneuern ihre Zertifikate beim Neustart, wenn sie in 90 Tagen ablaufen.',
  'std.kubeletCertificate.clientTitle': (p: { node: string; days: number }) => `Kubelet auf ${p.node}: Client-Zertifikat läuft in ${p.days} Tagen ab`,
  'std.kubeletCertificate.serverTitle': (p: { node: string; days: number }) => `Kubelet auf ${p.node}: Server-Zertifikat läuft in ${p.days} Tagen ab`,
  'std.kubeletCertificate.cause':
    'Der Kubelet erneuert seine Zertifikate selbst; dass es so knapp wird, heißt, die Erneuerung klappt nicht (ausstehende CSRs: kubectl get csr). Ohne gültiges Zertifikat verliert der Node die Verbindung zum API-Server.',
  'std.apiErrors.title': (p: { pct: number }) => `API-Server: ${dec(p.pct)} % der Anfragen scheitern`,
  'std.apiErrors.cause':
    'Der API-Server beantwortet so viele Anfragen mit 5xx, dass das Fehlerbudget von 1 % schnell aufgebraucht ist. Häufig sind ein nicht erreichbarer Aggregated API (metrics-server), ein überlastetes etcd oder ein fehlerhafter Webhook schuld. Die Logs des API-Servers zeigen, welche Anfragen scheitern.',
  'std.dnsErrors.title': (p: { pct: number }) => `DNS: ${dec(p.pct)} % der Antworten sind SERVFAIL`,
  'std.dnsErrors.cause':
    'CoreDNS kann seit 10 Minuten einen Teil der Namen nicht auflösen. Meist erreicht es seine Upstream-Resolver nicht (Forward in der Corefile) oder ein Plugin scheitert. Die Logs der CoreDNS-Pods zeigen die betroffenen Namen.',
  'std.dnsLatency.title': (p: { zone: string; seconds: number }) => `DNS antwortet langsam (${p.zone}: ${dec(p.seconds)} s)`,
  'std.dnsLatency.cause':
    'Die 99. Perzentile der Antwortzeit liegt seit 10 Minuten über 4 s; die meisten Clients geben nach 5 s auf, Anwendungen sehen Namen nicht mehr. Meist ein langsamer oder unerreichbarer Upstream-Resolver, oder CoreDNS ist am CPU-Limit.',
  'std.dnsForwardBroken.title': 'DNS: alle Upstream-Resolver gelten als ausgefallen',
  'std.dnsForwardBroken.cause':
    'Die Health-Checks von CoreDNS erreichen keinen der Resolver aus der Corefile. Externe Namen lösen dann nur noch zufällig auf. Netzwerk und Firewall der Nodes nach außen (Port 53) und die Resolver selbst prüfen.',
  'std.prometheusConfig.title': 'Prometheus kann seine Konfiguration nicht laden',
  'std.prometheusConfig.cause':
    'Das letzte Neuladen ist gescheitert; Prometheus läuft mit der vorigen Konfiguration weiter, Änderungen (neue Scrape-Ziele, Regeln) wirken nicht. Das Log von Prometheus nennt den Fehler.',
  'std.prometheusRuleFailures.title': (p: { group: string }) => `Prometheus-Regeln scheitern (${p.group})`,
  'std.prometheusRuleFailures.cause':
    'Die Regeln dieser Gruppe werden seit 15 Minuten nicht ausgewertet, auch ihre Alarme nicht. Meist eine fehlerhafte Abfrage oder doppelte Serien; das Log und die Seite Rules in Prometheus zeigen den Fehler.',
  'std.prometheusAlertmanager.title': 'Prometheus erreicht keinen Alertmanager',
  'std.prometheusAlertmanager.cause':
    'Prometheus hat keinen Alertmanager gefunden: Alarme feuern, kommen aber nirgends an. Die alerting-Konfiguration von Prometheus und den Service des Alertmanager prüfen.',
  'std.prometheusCompactions.title': 'Prometheus kann seine Daten nicht verdichten',
  'std.prometheusCompactions.cause':
    'Die Kompaktierung scheitert seit Stunden. Die Daten wachsen dann ungebremst, bis die Platte voll ist. Meist ist das Volume voll oder ein Block beschädigt; das Log von Prometheus nennt ihn.',

  'std.overcommit.cpuTitle': (p: { pct: number }) => `CPU-Requests: Ausfall des größten Nodes nicht verkraftbar (${p.pct} %)`,
  'std.overcommit.memoryTitle': (p: { pct: number }) => `Speicher-Requests: Ausfall des größten Nodes nicht verkraftbar (${p.pct} %)`,
  'std.overcommit.cause': (p: { pct: number }) =>
    `Die Pods fordern ${p.pct} % dessen an, was die übrigen Nodes ohne den größten bieten. Fällt er aus oder startet er neu, finden nicht alle seine Pods anderswo Platz und bleiben Pending. Requests senken, die keiner braucht, oder einen Node ergänzen.`,
  'std.tooManyPods.title': (p: { node: string; n: number; max: number }) => `${p.node}: ${p.n} von ${p.max} Pods`,
  'std.tooManyPods.cause': 'Der Node ist fast an seiner Pod-Grenze (maxPods des Kubelet); weitere Pods landen auf anderen Nodes oder bleiben Pending.',
  'std.versionMismatch.title': (p: { versions: string }) => `Verschiedene Kubernetes-Versionen im Cluster (${p.versions})`,
  'std.versionMismatch.cause': 'Während eines Upgrades ist das normal. Bleibt es so, ist ein Upgrade hängen geblieben: alle Nodes auf dieselbe Version bringen.',

  'std.reason.missing': 'Metrik fehlt',
  'std.reason.failed': 'Abfrage gescheitert',
  'std.reason.noPrometheus': 'braucht Prometheus',
  'std.detail.notApplying': 'Trifft hier nicht zu',
  'std.absent.raid': 'kein Software-RAID (md) auf den Nodes',
  'std.absent.quota': 'keine ResourceQuotas angelegt',
  'std.absent.kubeletCert': 'Kubelet meldet seine Zertifikate nicht (z. B. RKE2, k3s)',
  'std.reason.notApplicable': 'kein Alertmanager',
  'std.area.etcd': 'etcd',
  'std.area.nodes': 'Nodes',
  'std.area.kubernetes': 'Kubernetes',
  'std.area.dns': 'DNS',
  'std.area.prometheus': 'Prometheus',
  'std.rule.fires': (p: { n: number }) => `feuert (${p.n})`,
  'std.rule.ok': 'in Ordnung',
  'std.stat.etcdPeerRtt': 'etcd-Laufzeit p99',
  'std.stat.cpuWithoutLargest': 'CPU-Requests ohne größten Node',
  'std.stat.memoryWithoutLargest': 'RAM-Requests ohne größten Node',
  'std.stat.rules': 'Regeln geprüft',
  'std.needsPrometheus': 'braucht Prometheus',
  'std.detail.peers': 'etcd-Laufzeiten zwischen Mitgliedern',
  'std.detail.from': 'Von',
  'std.detail.to': 'Zu',
  'std.detail.rules': 'Regeln',
  'std.summary.ok': (p: { n: number }) => `${p.n} Regeln geprüft, keine feuert`,
  'std.summary.noPrometheus': 'Ohne Prometheus nur Requests, Pods pro Node und Versionen geprüft',
};
