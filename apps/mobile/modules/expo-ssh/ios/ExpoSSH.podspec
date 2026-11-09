Pod::Spec.new do |s|
  s.name = 'ExpoSSH'
  s.version = '1.0.0'
  s.summary = 'Ateam SSH transport, host verification and loopback forwarding'
  s.description = s.summary
  s.author = 'Clawnify'
  s.homepage = 'https://github.com/clawnify/ateam'
  s.license = { :type => 'GPL-3.0-or-later' }
  s.platforms = { :ios => '15.1' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  spm_dependency(s, url: 'https://github.com/apple/swift-nio-ssh.git',
    requirement: {kind: 'exactVersion', version: '0.15.1'}, products: ['NIOSSH'])
  spm_dependency(s, url: 'https://github.com/apple/swift-nio.git',
    requirement: {kind: 'exactVersion', version: '2.105.0'}, products: ['NIOCore', 'NIOPosix'])
  spm_dependency(s, url: 'https://github.com/apple/swift-crypto.git',
    requirement: {kind: 'exactVersion', version: '5.1.1'}, products: ['Crypto'])
end
