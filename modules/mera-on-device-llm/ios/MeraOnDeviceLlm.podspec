Pod::Spec.new do |s|
  s.name           = 'MeraOnDeviceLlm'
  s.version        = '1.0.0'
  s.summary        = 'Apple Foundation Models bindings for Mera on-device text generation'
  s.description    = 'Local Expo module wrapping the FoundationModels framework (the on-device Apple Intelligence model).'
  s.license        = { :type => 'PROPRIETARY' }
  s.author         = 'Mera Labs B.V.'
  s.homepage       = 'https://mera.news'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # FoundationModels exists only from iOS 26. Weak-linked, so the app still
  # launches on older iOS, where availability() answers osTooOld.
  s.weak_frameworks = 'FoundationModels'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
