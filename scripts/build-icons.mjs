#!/usr/bin/env node
/**
 * Reads every SVG in `icons/`, generates:
 *   - `src/icons/<Name>.tsx` — typed React component (via SVGR)
 *   - `src/icons/index.ts`   — barrel re-export
 *   - `src/registry.ts`      — { name → component } map with JSDoc base64 previews
 *
 * Filename rule: `Icon[_ ]<Words>.svg` → `<Words>` PascalCased (whitespace, `_`, `-` are separators).
 * The base64 preview is embedded only when the optimized SVG is small enough to keep
 * `.d.ts` size sane; oversized icons get a "preview omitted" note instead.
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from '@svgr/core';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_ICONS = resolve(ROOT, 'icons');
const OUT_ICONS_DIR = resolve(ROOT, 'src/icons');
const REGISTRY_FILE = resolve(ROOT, 'src/registry.ts');

// Each preview is rasterized to a 64×64 PNG so the JSDoc tooltip stays light
// regardless of how heavy the underlying SVG is (some source SVGs are multi-MB
// because they embed raster images).
const PREVIEW_PX = 64;

// Embedded raster images inside SVGs are capped at this dimension during codegen
// to shrink the runtime bundle. 256px is 4× a typical 64px @ 2x retina display,
// so visual fidelity at icon sizes is preserved. Vector content is never touched.
// Source SVGs in `icons/` are also never modified — only the codegen output.
const EMBEDDED_RASTER_MAX_PX = 256;

/**
 * Re-encode every embedded `<image data:image/...;base64,...>` raster inside the
 * SVG: decode, resize (only if it exceeds the cap), re-compress with PNG palette
 * encoding. Vector elements are untouched. Returns the rewritten SVG string and
 * a {originalRaster, newRaster} byte tally.
 *
 * Falls back to the original data URI on any decode/encode failure so a single
 * malformed bitmap never breaks the whole pipeline.
 */
async function shrinkEmbeddedRasters(svg) {
  const regex = /(["'])data:image\/(?:png|jpe?g|webp|gif);base64,([^"']+)\1/gi;
  const matches = [...svg.matchAll(regex)];
  if (matches.length === 0) {
    return { svg, originalRaster: 0, newRaster: 0, count: 0, skipped: 0 };
  }

  let originalRaster = 0;
  let newRaster = 0;
  let skipped = 0;
  let result = '';
  let pos = 0;

  for (const m of matches) {
    const [full, quote, base64Data] = m;
    result += svg.slice(pos, m.index);
    originalRaster += base64Data.length;

    let replacement = full;
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const meta = await sharp(buffer).metadata();
      let pipe = sharp(buffer);
      if (
        (meta.width ?? 0) > EMBEDDED_RASTER_MAX_PX ||
        (meta.height ?? 0) > EMBEDDED_RASTER_MAX_PX
      ) {
        pipe = pipe.resize(EMBEDDED_RASTER_MAX_PX, EMBEDDED_RASTER_MAX_PX, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      const reencoded = await pipe.png({ compressionLevel: 9, palette: true }).toBuffer();
      const newBase64 = reencoded.toString('base64');
      newRaster += newBase64.length;
      replacement = `${quote}data:image/png;base64,${newBase64}${quote}`;
    } catch (err) {
      skipped += 1;
      newRaster += base64Data.length;
    }

    result += replacement;
    pos = m.index + full.length;
  }
  result += svg.slice(pos);

  return { svg: result, originalRaster, newRaster, count: matches.length, skipped };
}

function toPascalCase(filename) {
  let name = basename(filename, extname(filename));
  name = name.replace(/^Icon[_ ]/i, '');
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

const SVGO_CONFIG = {
  multipass: true,
  plugins: [
    { name: 'preset-default', params: { overrides: { removeViewBox: false } } },
    'prefixIds',
  ],
};

async function main() {
  await rm(OUT_ICONS_DIR, { recursive: true, force: true });
  await mkdir(OUT_ICONS_DIR, { recursive: true });

  const files = (await readdir(SRC_ICONS))
    .filter((f) => f.toLowerCase().endsWith('.svg'))
    .sort();

  const seen = new Map();
  const entries = [];
  let totalOriginalRaster = 0;
  let totalNewRaster = 0;

  for (const file of files) {
    const componentName = toPascalCase(file);
    if (seen.has(componentName)) {
      throw new Error(
        `Name collision: "${file}" and "${seen.get(componentName)}" both → "${componentName}"`,
      );
    }
    seen.set(componentName, file);

    const raw = await readFile(resolve(SRC_ICONS, file), 'utf-8');
    const shrunk = await shrinkEmbeddedRasters(raw);
    totalOriginalRaster += shrunk.originalRaster;
    totalNewRaster += shrunk.newRaster;
    if (shrunk.skipped > 0) {
      console.warn(`  ${file}: ${shrunk.skipped}/${shrunk.count} embedded raster(s) could not be re-encoded — kept original`);
    }

    const tsx = await transform(
      shrunk.svg,
      {
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        typescript: true,
        ref: true,
        expandProps: 'end',
        jsxRuntime: 'automatic',
        prettier: false,
        svgo: true,
        svgoConfig: SVGO_CONFIG,
      },
      { componentName },
    );
    await writeFile(resolve(OUT_ICONS_DIR, `${componentName}.tsx`), tsx);

    // Rasterize the SVG to a small PNG thumbnail for the JSDoc preview.
    let preview = null;
    try {
      const pngBuffer = await sharp(Buffer.from(shrunk.svg), { density: 200 })
        .resize(PREVIEW_PX, PREVIEW_PX, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
      preview = {
        mime: 'image/png',
        base64: pngBuffer.toString('base64'),
      };
    } catch (err) {
      console.warn(`  preview failed for ${file}: ${err.message}`);
    }

    entries.push({
      name: componentName,
      sourceFile: file,
      preview,
    });
  }

  // src/icons/index.ts — barrel
  const barrel = entries
    .map((e) => `export { default as ${e.name} } from './${e.name}.js';`)
    .join('\n') + '\n';
  await writeFile(resolve(OUT_ICONS_DIR, 'index.ts'), barrel);

  // src/registry.ts — JSDoc-decorated map
  const properties = entries
    .map((e) => {
      const jsdoc = e.preview
        ? `  /**\n   * ![${e.name}](data:${e.preview.mime};base64,${e.preview.base64})\n   *\n   * Source: \`icons/${e.sourceFile}\`\n   */`
        : `  /**\n   * \`${e.name}\` — preview unavailable.\n   *\n   * Source: \`icons/${e.sourceFile}\`\n   */`;
      return `${jsdoc}\n  ${e.name}: Icons.${e.name},`;
    })
    .join('\n');

  const registry = `/* eslint-disable */
// AUTO-GENERATED by scripts/build-icons.mjs — do not edit by hand.
import * as Icons from './icons/index.js';

/**
 * Registry mapping every Sygnaal icon name to its React component.
 *
 * Each entry carries a JSDoc preview so hovering or autocompleting a
 * \`SygnaalIconName\` value renders the icon inline in your editor.
 */
export const SYGNAAL_ICONS = {
${properties}
} as const;

/** Union of every valid icon name. Hover any value to preview. */
export type SygnaalIconName = keyof typeof SYGNAAL_ICONS;
`;

  await writeFile(REGISTRY_FILE, registry);

  const withPreview = entries.filter((e) => e.preview !== null).length;
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(`Generated ${entries.length} icons → src/icons/`);
  console.log(`  ${withPreview} with preview, ${entries.length - withPreview} without`);
  if (totalOriginalRaster > 0) {
    const pct = ((1 - totalNewRaster / totalOriginalRaster) * 100).toFixed(1);
    console.log(`  embedded rasters: ${mb(totalOriginalRaster)} MB → ${mb(totalNewRaster)} MB  (-${pct}%)`);
  }
  console.log(`Wrote registry → src/registry.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
