// The store sizes and the device each one shows (docs/RELEASING.md,
// Screenshots). Shared by capture.cjs (takes the app at `viewport`) and
// frame/frame.cjs (puts that shot into a device on a canvas of `size`).
//
// App Store: 6.9" iPhone and 13" iPad, told apart by pixel size, so both go
// into the same folder. Play: 9:16 phone, 10:16 ten-inch tablet (Play wants
// each side between 320 and 3840 px and the long side at most twice the
// short one).
//
// `viewport` is a real device's screen in CSS pixels, `safe` the room the app
// leaves at the top and bottom (set through Ionic's safe-area variables), where
// the frame draws the status bar and the home indicator.
const ALL = [
  {
    id: 'iphone69', size: [1320, 2868], frame: 'island', platform: 'ios',
    viewport: [430, 932], scale: 3, safe: [59, 34], ua: 'iPhone 15 Pro Max', dir: (l) => `ios/${l}`,
  },
  {
    id: 'ipad13', size: [2064, 2752], frame: 'tablet', platform: 'ios',
    viewport: [834, 1112], scale: 2, safe: [24, 20], ua: 'iPad Pro 11', dir: (l) => `ios/${l}`,
  },
  {
    id: 'phone', size: [1080, 1920], frame: 'punch', platform: 'android',
    viewport: [412, 915], scale: 2.625, safe: [36, 16], ua: 'Pixel 7', dir: (l) => `android/${l}/images/phoneScreenshots`,
  },
  {
    id: 'tablet', size: [1600, 2560], frame: 'tablet', platform: 'android',
    viewport: [712, 1139], scale: 2.25, safe: [28, 16], ua: 'Galaxy Tab S4', dir: (l) => `android/${l}/images/tenInchScreenshots`,
  },
];

const TARGETS = ALL.filter((t) => !process.env.ONLY || process.env.ONLY.split(',').includes(t.id));

const LOCALES = ['en-US', 'de-DE'];

module.exports = { TARGETS, LOCALES };
