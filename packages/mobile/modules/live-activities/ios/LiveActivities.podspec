require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'LiveActivities'
  s.version        = package['version'] || '1.0.0'
  s.summary        = 'Local Expo module for iOS Live Activities (ActivityKit) — issue #1434'
  s.license        = 'MIT'
  s.author         = 'Portable'
  s.homepage       = 'https://portable.dev'
  s.platforms      = { :ios => '16.4' } # SDK 56 baseline; ActivityKit guarded at runtime
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
