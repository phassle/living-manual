// Where things are in a Living Manual workspace: the config file, a product's section in it and
// the kit's folder for the product (living-manual/products/<product>/). Shared by the kit's CLIs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG = 'living-manual/living-manual.config.json';

/** The workspace root: the nearest folder upwards from `from` that holds the kit's configuration. */
export function workspaceRoot(from = process.cwd()) {
	for (let d = resolve(from); ; d = dirname(d)) {
		if (existsSync(join(d, CONFIG))) return d;
		if (dirname(d) === d) throw new Error(`no ${CONFIG} in ${from} or any folder above it`);
	}
}

/** The product's section of the configuration; throws when the product is not configured. */
export function productConfig(root, product) {
	const section = JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).products?.[product];
	if (!section) throw new Error(`no product "${product}" in ${join(root, CONFIG)}`);
	return section;
}

/** The kit's folder for a product. */
export const productFolder = (root, product) => join(root, 'living-manual/products', product);

/**
 * Resolves the product folder from CLI arguments: `--folder <dir>` (any folder laid out like a
 * product folder, used by the kit's own tests) or `<product>` (looked up from the workspace).
 * Returns { folder, rest } where rest holds the remaining arguments; by product also { product, root }.
 */
export function folderFromArgs(argv) {
	const args = [...argv];
	const i = args.indexOf('--folder');
	if (i >= 0) {
		const folder = resolve(args[i + 1] ?? '');
		args.splice(i, 2);
		return { folder, rest: args };
	}
	const product = args.shift();
	if (!product || product.startsWith('-')) throw new Error('name a product, or pass --folder <dir>');
	const root = workspaceRoot();
	return { folder: productFolder(root, product), product, root, rest: args };
}
