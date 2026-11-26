# Adds native push to the iOS project, once (docs/NOTIFICATIONS.md, "Native
# push"; docs/RELEASING.md). Idempotent: running it again changes nothing.
#
#   cd app && bundle exec ruby scripts/add-push-extension.rb
#
# What it does to ios/App/App.xcodeproj:
# - the Notification Service Extension target KubernannyPushExtension
#   (ios/App/KubernannyPushExtension), embedded in the app, iOS 15;
# - its entitlements file (App Group group.app.kubernanny.push, whose keychain
#   access group holds the push keys, and group.app.kubernanny, the widget's,
#   where it writes the cluster state a push carries);
# - sources added later (WidgetPushStatus.swift, StatusPush.swift) to an
#   extension made before;
# - the extension's push code (PushCrypto, PushKeys, WidgetPushStatus,
#   StatusPush) also into the App target: the app opens the silent hourly
#   status push for the widget itself (AppDelegate), with the same code;
# - on the App target the Background Modes capability (remote notifications;
#   UIBackgroundModes in App/Info.plist carries `remote-notification`);
# - on the App target: the same App Group and aps-environment (push), merged
#   into the entitlements file the target already uses, or a new
#   App/App.entitlements. Other entries (the widget's App Group) stay;
# - a build phase that copies App/GoogleService-Info.plist into the bundle
#   when the file is there (it is never committed).
#
# A script rather than a hand edit of project.pbxproj, because several
# features add targets to the same project; xcodeproj (a fastlane
# dependency) writes it the way Xcode does.
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
PROJECT = File.join(ROOT, ENV.fetch('XCODEPROJ', 'App.xcodeproj'))
NAME = 'KubernannyPushExtension'
GROUP = 'group.app.kubernanny.push'
SOURCES = %w[NotificationService.swift PushCrypto.swift PushKeys.swift WidgetPushStatus.swift StatusPush.swift].freeze
# Compiled into the app as well, for the status push it receives in the background.
APP_SHARED = %w[PushCrypto.swift PushKeys.swift WidgetPushStatus.swift StatusPush.swift].freeze
WIDGET_GROUP = 'group.app.kubernanny'

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == 'App' } or abort('no App target')

def merge_entitlements(path, group, push)
  plist = File.exist?(path) ? Xcodeproj::Plist.read_from_path(path) : {}
  groups = (plist['com.apple.security.application-groups'] || []) | [group]
  plist['com.apple.security.application-groups'] = groups
  # Xcode's export replaces the value with the provisioning profile's (production for the App Store).
  plist['aps-environment'] ||= 'development' if push
  Xcodeproj::Plist.write_to_path(plist, path)
end

# The App target: its entitlements, the push capability.
app.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] ||= 'App/App.entitlements'
end
app.build_configurations.map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] }.uniq.each do |relative|
  merge_entitlements(File.join(ROOT, relative), GROUP, true)
end
app_group = project.main_group.children.find { |g| g.respond_to?(:path) && g.path == 'App' }
if app_group && app_group.files.none? { |f| f.path == 'App.entitlements' } && File.exist?(File.join(ROOT, 'App/App.entitlements'))
  app_group.new_reference('App.entitlements')
end
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
(attributes[app.uuid] ||= {})['SystemCapabilities'] = ((attributes[app.uuid] || {})['SystemCapabilities'] || {}).merge(
  'com.apple.Push' => { 'enabled' => 1 },
  'com.apple.ApplicationGroups.iOS' => { 'enabled' => 1 },
  'com.apple.BackgroundModes' => { 'enabled' => 1 }
)

# GoogleService-Info.plist is not in the repository (docs/RELEASING.md): a
# file reference would break every build without it. This phase copies it
# into the app bundle when it is there; without it the app has no push.
COPY_PHASE = 'Copy Firebase config if present'
unless app.shell_script_build_phases.any? { |p| p.name == COPY_PHASE }
  phase = app.new_shell_script_build_phase(COPY_PHASE)
  phase.shell_script = <<~SH
    SRC="${SRCROOT}/App/GoogleService-Info.plist"
    if [ -f "$SRC" ]; then
      cp "$SRC" "${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist"
    else
      echo "note: no GoogleService-Info.plist, this build has no native push"
    fi
  SH
  phase.always_out_of_date = '1'
end

extension = project.targets.find { |t| t.name == NAME }
unless extension
  extension = project.new_target(:app_extension, NAME, :ios, '15.0', nil, :swift)
  group = project.main_group.new_group(NAME, NAME)
  SOURCES.each { |file| extension.add_file_references([group.new_reference(file)]) }
  group.new_reference('Info.plist')
  group.new_reference("#{NAME}.entitlements")

  app_settings = app.build_configurations.first.build_settings
  extension.build_configurations.each do |config|
    s = config.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = 'app.kubernanny.PushExtension'
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{NAME}/Info.plist"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{NAME}/#{NAME}.entitlements"
    s['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['SKIP_INSTALL'] = 'YES'
    s['CODE_SIGN_STYLE'] = app_settings['CODE_SIGN_STYLE'] || 'Automatic'
    s['DEVELOPMENT_TEAM'] = app_settings['DEVELOPMENT_TEAM'] if app_settings['DEVELOPMENT_TEAM']
    # The extension ships with the app's version, or App Store Connect refuses the build.
    s['MARKETING_VERSION'] = app_settings['MARKETING_VERSION'] || '$(MARKETING_VERSION)'
    s['CURRENT_PROJECT_VERSION'] = app_settings['CURRENT_PROJECT_VERSION'] || '$(CURRENT_PROJECT_VERSION)'
  end
  (attributes[extension.uuid] ||= {})['SystemCapabilities'] = { 'com.apple.ApplicationGroups.iOS' => { 'enabled' => 1 } }

  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } || app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  build_file = embed.add_file_reference(extension.product_reference, true)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  app.add_dependency(extension)
end

# Sources added after the target was made.
ext_group = project.main_group.children.find { |g| g.respond_to?(:path) && g.path == NAME }
SOURCES.each do |file|
  next if extension.source_build_phase.files_references.any? { |f| f.path == file }
  ref = ext_group.files.find { |f| f.path == file } || ext_group.new_reference(file)
  extension.add_file_references([ref])
end

# The same push code in the App target (AppDelegate opens the status push).
APP_SHARED.each do |file|
  next if app.source_build_phase.files_references.any? { |f| f.path == file }
  app.add_file_references([ext_group.files.find { |f| f.path == file }])
end

# The widget's App Group: the extension writes a push's cluster state there (WidgetPushStatus.swift).
ext_entitlements = File.join(ROOT, NAME, "#{NAME}.entitlements")
plist = Xcodeproj::Plist.read_from_path(ext_entitlements)
unless (plist['com.apple.security.application-groups'] || []).include?(WIDGET_GROUP)
  plist['com.apple.security.application-groups'] = (plist['com.apple.security.application-groups'] || []) | [GROUP, WIDGET_GROUP]
  Xcodeproj::Plist.write_to_path(plist, ext_entitlements)
end

project.save
puts "#{NAME}: in #{File.basename(PROJECT)}; App entitlements carry #{GROUP} and aps-environment"
