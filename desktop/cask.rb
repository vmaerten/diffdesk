cask "ghl" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/vmaerten/ghl/releases/download/v#{version}/ghl_#{version}_darwin_arm64.zip"
  name "ghl"
  desc "Review the PR you are about to open, without opening it"
  homepage "https://github.com/vmaerten/ghl"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "ghl.app"
  binary "#{appdir}/ghl.app/Contents/MacOS/ghl"

  # Ad hoc signature, no notarisation: without this, Gatekeeper blocks the first launch.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/ghl.app"]
  end

  zap trash: [
    "~/Library/Application Support/ghl Desktop",
    "~/Library/Application Support/ghl",
    "~/Library/Caches/dev.ghl.desktop",
    "~/Library/Preferences/dev.ghl.desktop.plist",
    "~/Library/WebKit/dev.ghl.desktop",
  ]
end
