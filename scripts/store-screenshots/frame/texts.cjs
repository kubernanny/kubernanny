// Headline and subline of each store screenshot, per language. Benefit
// first, short enough for the stores' small previews, German with "du".
// Claim only what the app really does, and no em or en dashes.
// The keys are the screen files of capture.cjs (`SCREENS`); `<file>@tablet`
// replaces one on the tablet sizes.
module.exports = {
  en: {
    '01-overview': ['Is my cluster okay?', 'One glance tells you.'],
    '02-issues': ['What is broken, and why', 'With the cause and what helps'],
    '03-nodes': ['CPU and RAM per node', 'Used, reserved and limit'],
    '04-restarts': ['Restarts with their reason', 'OOMKilled too, against the limit'],
    '05-service': ['Deep inside your services', 'Postgres, Longhorn, Argo CD and more'],
    '06-ready-to-sync': ['Updates ready to sync', 'With everything that changes'],
    '07-clusters': ['All your clusters', 'One traffic light each'],
    '08-push': ['Push to your phone', 'End-to-end encrypted'],
    '08-push@tablet': ['Push to your tablet', 'End-to-end encrypted'],
  },
  de: {
    '01-overview': ['Ist mein Cluster okay?', 'Ein Blick genügt.'],
    '02-issues': ['Was kaputt ist, und warum', 'Mit Ursache und dem, was hilft'],
    '03-nodes': ['CPU und RAM pro Node', 'Genutzt, reserviert und Limit'],
    '04-restarts': ['Neustarts mit Grund', 'Auch OOMKilled, gegen das Limit'],
    '05-service': ['Tief in deinen Diensten', 'Postgres, Longhorn, Argo CD und mehr'],
    '06-ready-to-sync': ['Updates bereit zum Sync', 'Mit allem, was sich ändert'],
    '07-clusters': ['Alle deine Cluster', 'Je eine Ampel'],
    '08-push': ['Push aufs Handy', 'Ende-zu-Ende verschlüsselt'],
    '08-push@tablet': ['Push aufs Tablet', 'Ende-zu-Ende verschlüsselt'],
  },
};
