Pod::Spec.new do |s|
  s.name           = 'ExpoLeadCall'
  s.version        = '1.0.0'
  s.summary        = 'A call with the Lead as a system call, for Ateam mobile'
  s.description    = 'CallKit for an outgoing call, the audio session hand-off, the mic level on hold and the chime.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'MIT' }
  # MUST be <= the app's IPHONEOS_DEPLOYMENT_TARGET (15.1), or autolinking drops
  # the module (see ExpoSwiftterm.podspec).
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.frameworks     = 'AVFoundation', 'CallKit', 'StoreKit'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
