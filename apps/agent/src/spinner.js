const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s) => `\x1b[36m${s}\x1b[39m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const red = (s) => `\x1b[31m${s}\x1b[39m`;

/**
 * One-line progress for slow startup steps: an animated spinner with the elapsed time, turned
 * into ✔/✖ when the step ends. Plain "step..." lines when the stream isn't a terminal.
 */
export class Spinner {
	constructor(stream = process.stderr) {
		this.stream = stream;
		this.tty = Boolean(stream.isTTY);
		this.text = null;
		// Never leave the terminal without a cursor, however the process ends.
		process.on('exit', () => this.stop());
	}

	start(text) {
		this.stop();
		this.text = text;
		this.startedAt = Date.now();
		if (!this.tty) {
			this.stream.write(`  ${text}...\n`);
			return;
		}
		this.stream.write('\x1b[?25l');
		// Ctrl+C mid-step skips 'exit' handlers; restore the cursor before dying.
		this.onSigint = () => {
			this.stop();
			process.exit(130);
		};
		process.once('SIGINT', this.onSigint);
		let frame = 0;
		this.render(FRAMES[0]);
		this.timer = setInterval(() => this.render(FRAMES[++frame % FRAMES.length]), 80);
	}

	succeed() {
		this.finish(green('✔'));
	}

	fail() {
		this.finish(red('✖'));
	}

	/** Clears the spinner line (e.g. before an error message or an interactive prompt). */
	stop() {
		if (!this.text) return;
		clearInterval(this.timer);
		if (this.onSigint) process.removeListener('SIGINT', this.onSigint);
		this.onSigint = null;
		if (this.tty) this.stream.write('\r\x1b[2K\x1b[?25h');
		this.text = null;
	}

	render(frame) {
		this.stream.write(`\r\x1b[2K  ${cyan(frame)} ${this.text} ${dim(this.elapsed())}`);
	}

	finish(mark) {
		if (!this.text) return;
		const line = `  ${mark} ${this.text} ${dim(this.elapsed())}`;
		const tty = this.tty;
		this.stop();
		if (tty) this.stream.write(`${line}\n`);
	}

	elapsed() {
		return `${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
	}
}
