# Adds the home-screen widget to the iOS project, once (docs/RELEASING.md,
# "Widgets"). Idempotent: running it again changes nothing.
#
#   cd app && bundle exec ruby scripts/add-widget-extension.rb
#
# What it does to ios/App/App.xcodeproj:
# - the WidgetKit extension target KubernannyWidget (ios/App/KubernannyWidget,
#   bundle id app.kubernanny.KubernannyWidget), embedded in the app, with the
#   app's deployment target, linking WidgetKit and SwiftUI;
# - its entitlements file (App Group group.app.kubernanny, into which the
#   app's WidgetBridge plugin writes the clusters; the same id is the keychain
#   access group the background refresh keeps its targets in);
# - the local Swift package app/native/agent-call (KubernannyAgentCall), the
#   widget's own call to an agent for the background refresh;
# - on the App target: the same App Group, merged into the entitlements file
#   the target already uses, or a new App/App.entitlements. Other entries
#   (push's App Group, aps-environment) stay.
#
# The same approach as scripts/add-push-extension.rb: xcodeproj (a fastlane
# dependency) writes the project the way Xcode does.
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
PROJECT = File.join(ROOT, ENV.fetch('XCODEPROJ', 'App.xcodeproj'))
NAME = 'KubernannyWidget'
BUNDLE_ID = 'app.kubernanny.KubernannyWidget'
GROUP = 'group.app.kubernanny'
SOURCES = %w[KubernannyWidget.swift WidgetData.swift WidgetViews.swift ClusterIntent.swift].freeze
LOCALIZED = %w[Localizable.strings Localizable.stringsdict].freeze
LANGUAGES = %w[en de].freeze

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == 'App' } or abort('no App target')

def merge_entitlements(path, group)
  plist = File.exist?(path) ? Xcodeproj::Plist.read_from_path(path) : {}
  plist['com.apple.security.application-groups'] = (plist['com.apple.security.application-groups'] || []) | [group]
  Xcodeproj::Plist.write_to_path(plist, path)
end

# The App target: its entitlements, the App Group capability.
app.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] ||= 'App/App.entitlements'
end
app.build_configurations.map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] }.uniq.each do |relative|
  merge_entitlements(File.join(ROOT, relative), GROUP)
end
app_group = project.main_group.children.find { |g| g.respond_to?(:path) && g.path == 'App' }
if app_group && app_group.files.none? { |f| f.path == 'App.entitlements' } && File.exist?(File.join(ROOT, 'App/App.entitlements'))
  app_group.new_reference('App.entitlements')
end
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
(attributes[app.uuid] ||= {})['SystemCapabilities'] = ((attributes[app.uuid] || {})['SystemCapabilities'] || {}).merge(
  'com.apple.ApplicationGroups.iOS' => { 'enabled' => 1 }
)

extension = project.targets.find { |t| t.name == NAME }
unless extension
  app_settings = app.build_configurations.first.build_settings
  deployment = app_settings['IPHONEOS_DEPLOYMENT_TARGET'] || project.build_configurations.first.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '15.0'

  extension = project.new_target(:app_extension, NAME, :ios, deployment, nil, :swift)
  group = project.main_group.new_group(NAME, NAME)
  SOURCES.each { |file| extension.add_file_references([group.new_reference(file)]) }
  LOCALIZED.each do |file|
    variant = group.new_variant_group(file)
    LANGUAGES.each do |lang|
      ref = variant.new_reference("#{lang}.lproj/#{file}")
      ref.name = lang
      ref.last_known_file_type = 'text.plist.stringsdict' if file.end_with?('.stringsdict')
    end
    extension.resources_build_phase.add_file_reference(variant, true)
  end
  group.new_reference('Info.plist')
  group.new_reference("#{NAME}.entitlements")
  # Relative to the SDK, not to one Xcode's SDK path as add_system_frameworks writes it.
  frameworks = project.frameworks_group
  %w[WidgetKit SwiftUI].each do |framework|
    path = "System/Library/Frameworks/#{framework}.framework"
    ref = frameworks.files.find { |f| f.path == path } || frameworks.new_reference(path, :sdk_root)
    ref.last_known_file_type = 'wrapper.framework'
    extension.frameworks_build_phase.add_file_reference(ref, true)
  end

  extension.build_configurations.each do |config|
    s = config.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{NAME}/Info.plist"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{NAME}/#{NAME}.entitlements"
    s['IPHONEOS_DEPLOYMENT_TARGET'] = deployment
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['SKIP_INSTALL'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    s['ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME'] = nil
    s['CODE_SIGN_STYLE'] = app_settings['CODE_SIGN_STYLE'] || 'Automatic'
    s['DEVELOPMENT_TEAM'] = app_settings['DEVELOPMENT_TEAM'] if app_settings['DEVELOPMENT_TEAM']
    # The extension ships with the app's version, or App Store Connect refuses
    # the build; the release lane overrides both for every target.
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

# The background refresh: the local Swift package with the widget's call to an agent
# (app/native/agent-call), linked into the extension. The App target gets it through
# the WidgetBridge plugin's package (CapApp-SPM).
PACKAGE_PATH = '../../native/agent-call'
PACKAGE_PRODUCT = 'KubernannyAgentCall'
package = project.root_object.package_references.find { |r| r.respond_to?(:relative_path) && r.relative_path == PACKAGE_PATH }
unless package
  package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
  package.relative_path = PACKAGE_PATH
  project.root_object.package_references << package
end
unless extension.package_product_dependencies.any? { |d| d.product_name == PACKAGE_PRODUCT }
  dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dependency.package = package
  dependency.product_name = PACKAGE_PRODUCT
  extension.package_product_dependencies << dependency
  build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build_file.product_ref = dependency
  extension.frameworks_build_phase.files << build_file
end

project.save
puts "#{NAME}: in #{File.basename(PROJECT)}; App entitlements carry #{GROUP}; links #{PACKAGE_PRODUCT}"
