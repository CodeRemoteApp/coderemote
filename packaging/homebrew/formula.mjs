// Prints the Homebrew formula for a coderemote package tarball:
//
//   node packaging/homebrew/formula.mjs <tarball url> <sha256>
//
// The release workflow writes it into the CodeRemoteApp/homebrew-tap repository for each stable
// npm release (`brew install coderemoteapp/tap/coderemote`); CI installs one built from this
// checkout. Homebrew reads the version from the tarball's name (coderemote-1.2.3.tgz).
const [url, sha256] = process.argv.slice(2);
if (!url || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
	console.error('usage: node packaging/homebrew/formula.mjs <tarball url> <sha256>');
	process.exit(1);
}

process.stdout.write(`class Coderemote < Formula
  desc "Use your computer from your iPhone: files, git and a terminal over a Dev Tunnel"
  homepage "https://coderemoteapp.github.io/web/"
  url "${url}"
  sha256 "${sha256}"
  license "AGPL-3.0-or-later"

  depends_on "node"

  def install
    # The install scripts run: node-pty's picks or builds its native module, and coderemote's
    # makes node-pty's spawn-helper executable.
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")

    # node-pty ships prebuilt modules for other systems too; keep this one's.
    platform = "#{OS.mac? ? "darwin" : "linux"}-#{Hardware::CPU.intel? ? "x64" : "arm64"}"
    prebuilds = libexec/"lib/node_modules/coderemote/node_modules/node-pty/prebuilds"
    prebuilds.children.each { |dir| rm_r dir if dir.basename.to_s != platform } if prebuilds.exist?
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/coderemote --version").strip
  end
end
`);
