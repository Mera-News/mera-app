Pod::Spec.new do |s|
  s.name           = 'MeraDeviceAttest'
  s.version        = '1.0.0'
  s.summary        = 'DCAppAttestService bindings for Mera device sign-in'
  s.description    = 'Local Expo module wrapping Apple App Attest (DCAppAttestService).'
  s.license        = { :type => 'PROPRIETARY' }
  s.author         = 'Mera Labs B.V.'
  s.homepage       = 'https://mera.news'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
