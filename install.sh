#!/bin/sh
# Installs the coderemote CLI on macOS and Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/CodeRemoteApp/coderemote/main/install.sh | sh
#
# With Node.js 20 or newer this is `npm install -g coderemote`. Without it (or when npm's global
# folder needs sudo), the current Node.js LTS is downloaded from nodejs.org into
# ~/.coderemote/runtime/node, for coderemote's use only, and coderemote is installed there.
# ~/.coderemote/runtime/bin then holds `coderemote` and `node`, and goes at the end of PATH: the
# Claude Code plugin's hooks run `node`, and a Node.js installed later still comes first.
# Running it again updates that install (`coderemote update` does too).
#
# Environment: CODEREMOTE_VERSION (an npm version or dist-tag, default latest),
# CODEREMOTE_PRIVATE_NODE=1 (use the private Node.js even when one is installed),
# CODEREMOTE_NO_MODIFY_PATH=1 (leave shell startup files alone), CODEREMOTE_PACKAGE (an npm package
# spec to install instead, such as a tarball from `npm pack`: for testing).
set -eu

VERSION="${CODEREMOTE_VERSION:-latest}"
PACKAGE="${CODEREMOTE_PACKAGE:-coderemote@$VERSION}"
RUNTIME="${CODEREMOTE_RUNTIME_DIR:-$HOME/.coderemote/runtime}"
MIN_NODE=20
DIST=https://nodejs.org/dist

say() { printf '%s\n' "$*"; }
fail() {
	printf 'coderemote install: %s\n' "$*" >&2
	exit 1
}
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "needs curl or wget"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Whether this user can create or write `$1`, judged by its nearest existing ancestor.
writable() {
	d="$1"
	while [ ! -e "$d" ]; do d="$(dirname "$d")"; done
	[ -w "$d" ]
}

# A Node.js new enough on PATH, with npm's global folder writable without sudo. An earlier
# private install keeps being the one updated.
use_system_node() {
	[ "${CODEREMOTE_PRIVATE_NODE:-}" = 1 ] && return 1
	[ -e "$RUNTIME/bin/coderemote" ] && return 1
	command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
	[ "$(node_major node)" -ge "$MIN_NODE" ] || return 1
	prefix="$(npm prefix -g 2>/dev/null)" || return 1
	writable "$prefix/lib/node_modules" && writable "$prefix/bin"
}

platform() {
	case "$(uname -s)" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		*) fail "unsupported system $(uname -s) (on Windows, use install.ps1)" ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		*) fail "unsupported processor $(uname -m)" ;;
	esac
	# A shell under Rosetta reports x86_64 on Apple silicon.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
		arch=arm64
	fi
	if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
		fail "nodejs.org has no build for musl (Alpine): install Node.js $MIN_NODE+ and npm with your package manager, then run this again"
	fi
}

# The current Node.js LTS into $RUNTIME/node, unless it's already there.
install_node() {
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	download "$DIST/index.json" "$tmp/index.json"
	# index.json lists one release per line, newest first.
	v="$(grep '"lts":"' "$tmp/index.json" | head -n 1 | sed 's/.*"version":"\(v[0-9.]*\)".*/\1/')"
	[ -n "$v" ] || fail "couldn't find the current Node.js LTS on nodejs.org"
	if [ -x "$RUNTIME/node/bin/node" ] && [ "$("$RUNTIME/node/bin/node" -v 2>/dev/null)" = "$v" ]; then return; fi

	name="node-$v-$os-$arch"
	say "Downloading Node.js $v for coderemote ($os-$arch)…"
	download "$DIST/$v/$name.tar.gz" "$tmp/$name.tar.gz"
	download "$DIST/$v/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
	want="$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
	[ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$name.tar.gz")" ] || fail "$name.tar.gz doesn't match its checksum"
	tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
	# Minimal distributions can lack a library it links (libatomic, for one).
	"$tmp/$name/bin/node" -v >/dev/null 2>"$tmp/error" ||
		fail "Node.js $v from nodejs.org doesn't run on this system: $(head -n 1 "$tmp/error"). Install Node.js $MIN_NODE+ and npm with your package manager, then run this again"
	mkdir -p "$RUNTIME"
	rm -rf "$RUNTIME/node"
	mv "$tmp/$name" "$RUNTIME/node"
}

install_private() {
	platform
	install_node
	say "Installing $PACKAGE…"
	# node-pty's install scripts run `node`: this one.
	PATH="$RUNTIME/node/bin:$PATH" "$RUNTIME/node/bin/node" "$RUNTIME/node/lib/node_modules/npm/bin/npm-cli.js" \
		install -g --prefix "$RUNTIME/node" --no-fund --no-audit "$PACKAGE" ||
		fail "npm couldn't install coderemote.$([ "$os" = linux ] && printf ' On Linux, node-pty is compiled on install: it needs python3, make and a C++ compiler (build-essential).')"

	mkdir -p "$RUNTIME/bin"
	ln -sf "$RUNTIME/node/bin/node" "$RUNTIME/bin/node"
	cat >"$RUNTIME/bin/coderemote" <<EOF
#!/bin/sh
exec $(quote "$RUNTIME/node/bin/node") $(quote "$RUNTIME/node/lib/node_modules/coderemote/dist/coderemote.js") "\$@"
EOF
	chmod 755 "$RUNTIME/bin/coderemote"
}

# Appends $RUNTIME/bin to PATH in the startup file of the user's shell.
add_to_path() {
	dir="$RUNTIME/bin"
	if [ "${CODEREMOTE_NO_MODIFY_PATH:-}" = 1 ]; then
		say "Add $dir to PATH to use coderemote."
		return
	fi
	line="export PATH=\"\$PATH:$dir\""
	case "$(basename "${SHELL:-sh}")" in
		zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
		fish)
			rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/coderemote.fish"
			line="fish_add_path --append --path $(quote "$dir")"
			;;
		*) rc="$HOME/.profile" ;;
	esac
	if ! grep -qsF "$dir" "$rc"; then
		mkdir -p "$(dirname "$rc")"
		printf '\n# coderemote\n%s\n' "$line" >>"$rc"
		say "Added $dir to PATH in $rc."
	fi
	case ":$PATH:" in *":$dir:"*) ;; *) restart=1 ;; esac
}

restart=
if use_system_node; then
	say "Installing $PACKAGE with npm (Node.js $(node -v))…"
	npm install -g --no-fund --no-audit "$PACKAGE" || fail "npm install -g coderemote failed"
	cli="$(npm prefix -g)/bin/coderemote"
else
	install_private
	add_to_path
	cli="$RUNTIME/bin/coderemote"
fi

say ""
say "coderemote $("$cli" --version) is installed."
[ -n "$restart" ] && say "Open a new terminal so PATH picks it up."
say "Run \`coderemote up\` in a folder to share it with your phone."
