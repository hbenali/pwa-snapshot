import fetch from "node-fetch";
import archiver from "archiver";
import { createWriteStream, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { JSDOM } from "jsdom";

/**
 * Resolve a potentially relative URL against a base.
 */
function resolve(base, href) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch with timeout. Returns { ok, status, buffer, text, json } helpers.
 */
async function timedFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to discover the manifest URL from an HTML page.
 */
async function findManifestUrl(pageUrl, timeoutMs, verbose) {
  if (verbose) console.log(`  → fetching page ${pageUrl}`);
  const res = await timedFetch(pageUrl, timeoutMs);
  if (!res.ok) throw new Error(`Page fetch failed: ${res.status} ${pageUrl}`);

  const html = await res.text();
  const dom = new JSDOM(html);
  const link = dom.window.document.querySelector('link[rel="manifest"]');
  if (!link) throw new Error('No <link rel="manifest"> found in the page HTML.');

  return resolve(pageUrl, link.getAttribute("href"));
}

/**
 * Download a binary URL and return its Buffer.
 */
async function fetchBuffer(url, timeoutMs, verbose) {
  if (verbose) console.log(`  → fetching ${url}`);
  const res = await timedFetch(url, timeoutMs);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Build the snapshot zip into opts.output.
 */
export async function snapshot(rawUrl, opts) {
  // Lazy-load ora and chalk (ESM-only, keep compat easy)
  const { default: ora } = await import("ora");
  const { default: chalk } = await import("chalk");

  // Normalise the input URL
  const pageUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
  const spinner = ora("Discovering manifest…").start();

  // ── 1. Locate manifest ──────────────────────────────────────────────────
  let manifestUrl;
  try {
    // If the URL already ends with .json / .webmanifest treat it directly
    if (/\.(webmanifest|json)$/.test(pageUrl)) {
      manifestUrl = pageUrl;
    } else {
      manifestUrl = await findManifestUrl(pageUrl, opts.timeout, opts.verbose);
    }
    spinner.succeed(`Manifest found: ${chalk.cyan(manifestUrl)}`);
  } catch (err) {
    spinner.fail(err.message);
    throw err;
  }

  // ── 2. Fetch manifest JSON ───────────────────────────────────────────────
  spinner.start("Fetching manifest…");
  let manifest;
  try {
    const res = await timedFetch(manifestUrl, opts.timeout);
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    manifest = await res.json();
    spinner.succeed("Manifest fetched");
  } catch (err) {
    spinner.fail(err.message);
    throw err;
  }

  // ── 3. Resolve icon URLs ─────────────────────────────────────────────────
  const icons = (manifest.icons ?? []).map((icon) => ({
    ...icon,
    resolvedUrl: resolve(manifestUrl, icon.src),
  }));

  // ── 4. Download icons ────────────────────────────────────────────────────
  spinner.start(`Downloading ${icons.length} icon(s)…`);
  const downloadedIcons = [];

  for (const icon of icons) {
    if (!icon.resolvedUrl) {
      console.warn(`  ⚠ Could not resolve icon src: ${icon.src}`);
      continue;
    }
    try {
      const buf = await fetchBuffer(icon.resolvedUrl, opts.timeout, opts.verbose);
      const ext = icon.resolvedUrl.split(".").pop().split("?")[0] || "png";
      const filename = `icons/${icon.sizes ?? "any"}_${downloadedIcons.length}.${ext}`;
      downloadedIcons.push({ ...icon, buf, filename });
    } catch (err) {
      console.warn(`  ⚠ Skipping icon ${icon.resolvedUrl}: ${err.message}`);
    }
  }
  spinner.succeed(`Downloaded ${downloadedIcons.length} icon(s)`);

  // ── 5. Try to generate missing sizes with sharp (optional) ───────────────
  const generatedIcons = [];
  if (opts.resize && downloadedIcons.length > 0) {
    spinner.start("Generating missing icon sizes…");
    let sharp;
    try {
      const sharpMod = await import("sharp");
      sharp = sharpMod.default;
    } catch {
      spinner.warn("sharp not installed — skipping icon resizing. Run: npm i sharp");
    }

    if (sharp) {
      // Find the largest downloaded icon to use as source
      const source = downloadedIcons.reduce((best, cur) => {
        const sz = parseInt((cur.sizes ?? "0x0").split("x")[0]) || 0;
        const bestSz = parseInt((best.sizes ?? "0x0").split("x")[0]) || 0;
        return sz > bestSz ? cur : best;
      });

      const existingSizes = new Set(
        downloadedIcons.flatMap((ic) =>
          (ic.sizes ?? "").split(" ").map((s) => parseInt(s))
        )
      );

      for (const size of opts.iconSizes) {
        if (existingSizes.has(size)) continue;
        try {
          const buf = await sharp(source.buf).resize(size, size).png().toBuffer();
          generatedIcons.push({
            sizes: `${size}x${size}`,
            purpose: "any maskable",
            buf,
            filename: `icons/generated_${size}.png`,
            resolvedUrl: null,
          });
        } catch (err) {
          console.warn(`  ⚠ Could not generate ${size}x${size}: ${err.message}`);
        }
      }
      spinner.succeed(`Generated ${generatedIcons.length} extra icon size(s)`);
    }
  }

  const allIcons = [...downloadedIcons, ...generatedIcons];

  // ── 6. Build enriched manifest for the zip ───────────────────────────────
  const enrichedManifest = {
    ...manifest,
    // Rewrite icon srcs to local paths
    icons: allIcons.map((ic) => ({
      src: ic.filename,
      sizes: ic.sizes,
      type: ic.filename.endsWith(".svg") ? "image/svg+xml" : "image/png",
      purpose: ic.purpose ?? "any",
    })),
    // Preserve the original PWA start URL so Bubblewrap can use it
    start_url: manifest.start_url ?? "/",
    // Keep the original scope
    scope: manifest.scope ?? "/",
  };

  // ── 7. Build meta.json ───────────────────────────────────────────────────
  const meta = {
    snapshotVersion: "1",
    createdAt: new Date().toISOString(),
    sourceUrl: pageUrl,
    manifestUrl,
    name: manifest.name ?? manifest.short_name ?? "App",
    shortName: manifest.short_name ?? manifest.name ?? "App",
    description: manifest.description ?? "",
    themeColor: manifest.theme_color ?? "#ffffff",
    backgroundColor: manifest.background_color ?? "#ffffff",
    startUrl: manifest.start_url ?? "/",
    scope: manifest.scope ?? "/",
    display: manifest.display ?? "standalone",
    orientation: manifest.orientation ?? "any",
    categories: manifest.categories ?? [],
    iconCount: allIcons.length,
  };

  // ── 8. Pack into zip ─────────────────────────────────────────────────────
  spinner.start(`Packing → ${opts.output}`);

  // Ensure the output parent directory exists (matters for Docker volume mounts)
  mkdirSync(dirname(opts.output), { recursive: true });

  await new Promise((resolve, reject) => {
    const output = createWriteStream(opts.output);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    // manifest.json (enriched)
    archive.append(JSON.stringify(enrichedManifest, null, 2), {
      name: "manifest.json",
    });

    // meta.json
    archive.append(JSON.stringify(meta, null, 2), { name: "meta.json" });

    // icons
    for (const icon of allIcons) {
      archive.append(icon.buf, { name: icon.filename });
    }

    archive.finalize();
  });

  spinner.succeed(
    chalk.green(`Snapshot saved → ${opts.output}`) +
      `  (${allIcons.length} icons, ${
        Math.round(
          allIcons.reduce((a, ic) => a + ic.buf.length, 0) / 1024
        )
      } KB)`
  );

  console.log(
    chalk.dim(
      "\nUpload this zip to a GitHub Release or any CDN and pass the\n" +
        "direct download URL as the `snapshot_url` input in your workflow.\n"
    )
  );

  return { manifest: enrichedManifest, meta, iconCount: allIcons.length };
}
