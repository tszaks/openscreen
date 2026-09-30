// Headless export: `OpenScreen --export <bundle> --out <file> [--gif]
// [--preset id,id] [--timeout s]`. Pure argv parsing so it is unit-tested;
// main owns the window and the process exit.

export interface HeadlessJob {
  bundleDir: string;
  /** A .mp4/.gif file, or a folder when `presets` is set. */
  out: string;
  gif: boolean;
  /** Multi-format export (exportPresets ids) into the `out` folder. */
  presets?: string[];
  /** Give up (and exit 1) after this many seconds. */
  timeoutSec: number;
}

export interface HeadlessResult {
  ok: boolean;
  out?: string;
  files?: string[];
  frames?: number;
  /** Output video length in seconds. */
  seconds?: number;
  error?: string;
}

export const DEFAULT_HEADLESS_TIMEOUT_SEC = 1800;

/** Value of `--name value` or `--name=value`, else undefined. */
function flag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) return argv[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

/**
 * The headless job in `argv`, null when this is a normal GUI launch, or an
 * error string when `--export` was given but the job is malformed.
 */
export function parseHeadlessArgs(argv: string[]): HeadlessJob | { error: string } | null {
  if (!argv.some((a) => a === '--export' || a.startsWith('--export='))) return null;
  const bundleDir = flag(argv, '--export');
  if (!bundleDir || bundleDir.startsWith('--')) return { error: '--export needs a bundle directory' };
  const out = flag(argv, '--out');
  if (!out || out.startsWith('--')) return { error: '--out needs an output path' };
  const presetRaw = flag(argv, '--preset');
  const presets = presetRaw ? presetRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const gif = argv.includes('--gif') || /\.gif$/i.test(out);
  if (gif && presets?.length) return { error: '--gif and --preset cannot be combined' };
  if (!presets?.length && !/\.(mp4|gif)$/i.test(out)) return { error: '--out must end in .mp4 or .gif (or pass --preset with a folder)' };
  const t = Number(flag(argv, '--timeout') ?? DEFAULT_HEADLESS_TIMEOUT_SEC);
  if (!(t > 0)) return { error: '--timeout must be a positive number of seconds' };
  return { bundleDir, out, gif, ...(presets?.length ? { presets } : {}), timeoutSec: t };
}
