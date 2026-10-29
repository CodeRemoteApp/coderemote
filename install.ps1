# Installs the coderemote CLI on Windows:
#
#   irm https://raw.githubusercontent.com/CodeRemoteApp/coderemote/main/install.ps1 | iex
#
# With Node.js 22 or newer this is `npm install -g coderemote`. Without it, the current Node.js
# LTS is downloaded from nodejs.org into ~\.coderemote\runtime\node, for coderemote's use only,
# and coderemote is installed there. ~\.coderemote\runtime\bin then holds `coderemote` and
# `node` and goes at the end of the user's PATH: the Claude Code plugin's hooks run `node`, and a
# Node.js installed later still comes first. Running it again updates that install
# (`coderemote update` does too).
#
# Environment: CODEREMOTE_VERSION (an npm version or dist-tag, default latest),
# CODEREMOTE_PRIVATE_NODE=1 (use the private Node.js even when one is installed),
# CODEREMOTE_NO_MODIFY_PATH=1 (leave the user's PATH alone), CODEREMOTE_PACKAGE (an npm package
# spec to install instead, such as a tarball from `npm pack`: for testing).
#
# Runs in Windows PowerShell 5.1. Piped into iex it runs in the caller's session, so it never
# calls `exit` (that would close their window) and keeps its variables inside the script block.

& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with it
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$version = if ($env:CODEREMOTE_VERSION) { $env:CODEREMOTE_VERSION } else { 'latest' }
	$package = if ($env:CODEREMOTE_PACKAGE) { $env:CODEREMOTE_PACKAGE } else { "coderemote@$version" }
	$runtime = if ($env:CODEREMOTE_RUNTIME_DIR) { $env:CODEREMOTE_RUNTIME_DIR } else { Join-Path $HOME '.coderemote\runtime' }
	$nodeDir = Join-Path $runtime 'node'
	$bin = Join-Path $runtime 'bin'
	$minNode = 22
	$dist = 'https://nodejs.org/dist'

	function Fail($message) { throw "coderemote install: $message" }

	function Get-NodeMajor($node) {
		try { [int](& $node -p "process.versions.node.split('.')[0]") } catch { 0 }
	}

	# A Node.js new enough on PATH. An earlier private install keeps being the one updated.
	function Find-SystemNpm {
		if ($env:CODEREMOTE_PRIVATE_NODE -eq '1' -or (Test-Path (Join-Path $bin 'coderemote.cmd'))) { return $null }
		$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		# npm.cmd, not npm: PowerShell would pick npm.ps1, which the execution policy may block.
		$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		if (-not $node -or -not $npm -or (Get-NodeMajor $node.Source) -lt $minNode) { return $null }
		$npm.Source
	}

	# The current Node.js LTS into $nodeDir, unless it's already there.
	function Install-Node {
		$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
		$arch = switch ($arch) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { Fail "unsupported processor $arch" } }
		# Assigned first: PowerShell 5.1 pipes a JSON array on as one object.
		$releases = Invoke-RestMethod -UseBasicParsing "$dist/index.json"
		$lts = $releases | Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" } | Select-Object -First 1
		if (-not $lts) { Fail "couldn't find the current Node.js LTS on nodejs.org" }
		$v = $lts.version
		$node = Join-Path $nodeDir 'node.exe'
		if ((Test-Path $node) -and (& $node -v) -eq $v) { return }

		$name = "node-$v-win-$arch"
		Write-Host "Downloading Node.js $v for coderemote (win-$arch)..."
		# Next to its destination: Move-Item can't move a folder to another drive.
		$tmp = Join-Path $runtime '.download'
		if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
		New-Item -ItemType Directory -Force $tmp | Out-Null
		try {
			$zip = Join-Path $tmp "$name.zip"
			Invoke-WebRequest -UseBasicParsing "$dist/$v/$name.zip" -OutFile $zip
			Invoke-WebRequest -UseBasicParsing "$dist/$v/SHASUMS256.txt" -OutFile (Join-Path $tmp 'SHASUMS256.txt')
			$want = Get-Content (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match "^(\w+)\s+$([regex]::Escape("$name.zip"))$" } |
				ForEach-Object { $Matches[1] } | Select-Object -First 1
			if (-not $want -or $want -ne (Get-FileHash $zip -Algorithm SHA256).Hash) { Fail "$name.zip doesn't match its checksum" }
			$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
			if (Test-Path $tar) {
				& $tar -xf $zip -C $tmp
				if ($LASTEXITCODE) { Fail "couldn't extract $name.zip" }
			} else {
				Expand-Archive $zip -DestinationPath $tmp
			}
			if (Test-Path $nodeDir) {
				try { Remove-Item -Recurse -Force $nodeDir }
				catch { Fail "couldn't replace $nodeDir, which is in use: stop the agents (coderemote stop --all) and run this again" }
			}
			Move-Item (Join-Path $tmp $name) $nodeDir
		} finally {
			Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
		}
	}

	function Install-Private {
		Install-Node
		Write-Host "Installing $package..."
		$node = Join-Path $nodeDir 'node.exe'
		$path = $env:Path
		$env:Path = "$nodeDir;$env:Path" # node-pty's install scripts run `node`: this one.
		try {
			& $node (Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js') install -g --prefix $nodeDir --no-fund --no-audit $package
			if ($LASTEXITCODE) { Fail "npm couldn't install coderemote" }
		} finally {
			$env:Path = $path
		}

		New-Item -ItemType Directory -Force $bin | Out-Null
		# A real node.exe: hooks run `node` without a shell, which can't start a .cmd.
		$link = Join-Path $bin 'node.exe'
		if (Test-Path $link) {
			try { Remove-Item -Force $link } catch { Fail "couldn't replace $link, which is in use: close Claude Code and Codex, then run this again" }
		}
		try { New-Item -ItemType HardLink -Path $link -Target $node | Out-Null } catch { Copy-Item $node $link }
		# Relative to the .cmd, so it holds no user name that the console's code page could mangle.
		Set-Content -Encoding Ascii (Join-Path $bin 'coderemote.cmd') '@"%~dp0..\node\node.exe" "%~dp0..\node\node_modules\coderemote\dist\coderemote.js" %*'
	}

	# Appends $bin to the user's PATH, kept as REG_EXPAND_SZ so its %VARIABLES% still expand.
	function Add-ToPath {
		if ($env:CODEREMOTE_NO_MODIFY_PATH -eq '1') {
			Write-Host "Add $bin to PATH to use coderemote."
			return $false
		}
		$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
		try {
			$userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
			if (($userPath -split ';') -notcontains $bin) {
				$key.SetValue('Path', (($userPath.TrimEnd(';') + ";$bin").TrimStart(';')), [Microsoft.Win32.RegistryValueKind]::ExpandString)
				# Setting a variable through .NET broadcasts the change, so new terminals see it.
				[Environment]::SetEnvironmentVariable('CODEREMOTE_INSTALL', '1', 'User')
				[Environment]::SetEnvironmentVariable('CODEREMOTE_INSTALL', $null, 'User')
				Write-Host "Added $bin to your PATH."
			}
		} finally {
			$key.Close()
		}
		($env:Path -split ';') -notcontains $bin
	}

	try {
		$restart = $false
		$npm = Find-SystemNpm
		if ($npm) {
			Write-Host "Installing $package with npm (Node.js $(node -v))..."
			& $npm install -g --no-fund --no-audit $package
			if ($LASTEXITCODE) { Fail 'npm install -g coderemote failed' }
			$cli = Join-Path (& $npm prefix -g) 'coderemote.cmd'
		} else {
			Install-Private
			$restart = Add-ToPath
			$cli = Join-Path $bin 'coderemote.cmd'
		}
		Write-Host ''
		Write-Host "coderemote $(& $cli --version) is installed."
		if ($restart) { Write-Host 'Open a new terminal so PATH picks it up.' }
		Write-Host 'Run `coderemote up` in a folder to share it with your phone.'
	} catch {
		Write-Host $_.Exception.Message -ForegroundColor Red
	}
}
