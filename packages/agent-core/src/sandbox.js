import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * Confines file access to one directory tree. Paths are checked after resolving symlinks,
 * so neither `..` nor a link pointing outside can escape the root.
 */
export class Sandbox {
	constructor(root) {
		this.root = path.resolve(root);
		// The native realpath, like fs.promises.realpath below: on Windows the JS one keeps 8.3
		// short names (C:\Users\JOHNSM~1), so the two would never agree.
		this.realRoot = fsSync.realpathSync.native(this.root);
	}

	#containsReal(p) {
		return p === this.realRoot || p.startsWith(this.realRoot + path.sep);
	}

	#containsLexically(p) {
		return p === this.root || p.startsWith(this.root + path.sep);
	}

	/**
	 * Returns the absolute path for `p` (absolute, or relative to the root) after checking that
	 * it really lives inside the root. With `allowMissing`, the path may not exist yet
	 * (write/mkdir/rename targets); its nearest existing ancestor must still resolve inside.
	 */
	async resolve(p, { allowMissing = false } = {}) {
		return (await this.#check(p, allowMissing)).abs;
	}

	/** Like `resolve`, but refuses the root itself (deleting or renaming the shared folder). */
	async resolveChild(p, { allowMissing = false } = {}) {
		const { abs, real } = await this.#check(p, allowMissing);
		if (real === this.realRoot) throw new HttpError(403, 'cannot modify the shared folder itself');
		return abs;
	}

	async #check(p, allowMissing) {
		if (typeof p !== 'string' || p === '') throw new HttpError(400, 'missing path');
		// path.resolve normalizes away `..`, so the missing tail below is a plain list of names.
		const abs = path.resolve(this.root, p);
		let existing = abs;
		let tail = '';
		while (true) {
			try {
				const real = path.join(await fs.realpath(existing), tail);
				if (!this.#containsReal(real)) throw outside();
				return { abs, real };
			} catch (e) {
				if (e instanceof HttpError) throw e;
				// Don't reveal whether paths outside the root exist.
				if (!this.#containsLexically(abs)) throw outside();
				if (e.code !== 'ENOENT' || !allowMissing) throw e;
				const parent = path.dirname(existing);
				if (parent === existing) throw e;
				tail = path.join(path.basename(existing), tail);
				existing = parent;
			}
		}
	}
}

function outside() {
	return new HttpError(403, 'path is outside the shared folder');
}
