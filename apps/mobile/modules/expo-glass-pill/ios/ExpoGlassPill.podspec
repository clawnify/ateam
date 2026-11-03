Pod::Spec.new do |s|
  s.name           = 'ExpoGlassPill'
  s.version        = '1.0.0'
  s.summary        = 'A capsule of Liquid Glass for Ateam mobile'
  s.description    = 'UIGlassEffect behind the floating pills, on the legacy architecture.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'MIT' }
  # MUST be <= the app's IPHONEOS_DEPLOYMENT_TARGET (15.1), or autolinking drops
  # the module (see ExpoSwiftterm.podspec). The glass itself needs iOS 26 and is
  # checked at runtime.
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
