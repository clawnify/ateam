Pod::Spec.new do |s|
  s.name           = 'ExpoSwiftterm'
  s.version        = '1.0.0'
  s.summary        = 'Native SwiftTerm terminal view for Ateam mobile'
  s.description    = 'Wraps SwiftTerm (vendored) as an Expo native view — native scroll, selection, copy.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'MIT' }
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Our module Swift + the vendored SwiftTerm sources (compiled into this pod, so
  # its `TerminalView` is in-module — no `import SwiftTerm` needed). The one .metal
  # shader is compiled by CocoaPods into the pod's metallib.
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}", "vendor/SwiftTerm/**/*.metal"
end
