import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, hostname, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    output: { type: 'string' },
    samples: { type: 'string', default: '21' },
    warmup: { type: 'string', default: '3' },
  },
});
if (!values.before || !values.after || !values.output) {
  throw new Error('Pass --before, --after and --output');
}
const samples = Number(values.samples);
const warmup = Number(values.warmup);
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'vp-native-diagnostic-')));
const cliPackage = fileURLToPath(new URL('../../packages/cli/', import.meta.url));
const fixture = path.join(temporary, 'project');
const app = path.join(fixture, 'packages/app');
const bin = path.join(temporary, 'bin');
const files = [0, 1, 2].map((i) => `packages/app/src/f${i}.ts`);
const configs = {
  none: undefined,
  minimal: "export default { staged: { '*.ts': 'vp check --fix' } };\n",
  defined:
    "import { defineConfig } from 'vite-plus';\nexport default defineConfig({ staged: { '*.ts': 'vp check --fix' } });\n",
  blocks: "export default { staged: { '*.ts': 'vp check --fix' }, lint: {}, fmt: {} };\n",
  noop: "export default { staged: { '*.ts': 'node -e \"process.exit(0)\"' } };\n",
};
const cases = [
  { id: 'root/check/no-config', config: 'none', command: 'check' },
  { id: 'root/check/minimal', config: 'minimal', command: 'check' },
  { id: 'root/check/defineConfig', config: 'defined', command: 'check' },
  { id: 'package/check/minimal', config: 'minimal', command: 'check', package: true },
  { id: 'package/check/blocks', config: 'blocks', command: 'check', package: true },
  { id: 'root/fmt/minimal', config: 'minimal', command: 'fmt' },
  { id: 'root/lint/minimal', config: 'minimal', command: 'lint' },
  { id: 'root/staged/minimal', config: 'minimal', command: 'staged' },
  { id: 'root/staged/noop', config: 'noop', command: 'staged' },
];
const variants = [
  { label: 'before', binding: path.resolve(values.before) },
  { label: 'after', binding: path.resolve(values.after) },
  { label: 'control', binding: path.resolve(values.after) },
];
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    key.startsWith('VP_') ||
    key.startsWith('GIT_') ||
    ['DEBUG', 'NODE_OPTIONS', 'NODE_DISABLE_COMPILE_CACHE', 'NAPI_RS_NATIVE_LIBRARY_PATH'].includes(
      key,
    )
  ) {
    delete env[key];
  }
}
Object.assign(env, { PATH: `${bin}${path.delimiter}${env.PATH}`, NO_COLOR: '1', FORCE_COLOR: '0' });
function run(program, args, cwd = fixture, extraEnv = {}) {
  const start = performance.now();
  const child = spawnSync(program, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60000,
  });
  const elapsed = performance.now() - start;
  if (child.error || child.status !== 0) {
    throw new Error(
      `${program} ${args.join(' ')}: ${child.error ?? ''}\n${child.stdout}\n${child.stderr}`,
    );
  }
  return { elapsed, stdout: child.stdout, stderr: child.stderr };
}
const git = (...args) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args]).stdout;
function telemetry() {
  return Object.fromEntries(
    [
      '/proc/cpuinfo',
      '/proc/stat',
      '/proc/loadavg',
      '/sys/fs/cgroup/cpu.stat',
      '/sys/fs/cgroup/cpu.max',
    ]
      .filter(existsSync)
      .map((file) => [file, readFileSync(file, 'utf8')]),
  );
}
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus(),
  hostname: hostname(),
  kernel: release(),
  beforeRevision: process.env.BASE_NATIVE_REVISION,
  afterRevision: process.env.HEAD_NATIVE_REVISION,
  nativeProfile: process.env.CI ? 'release' : 'debug',
  samples,
  warmup,
  configs,
  variants: variants.map((v) => ({
    label: v.label,
    sha256: createHash('sha256').update(readFileSync(v.binding)).digest('hex'),
  })),
  telemetryBefore: telemetry(),
  measurements: [],
};
try {
  mkdirSync(path.join(app, 'src'), { recursive: true });
  mkdirSync(path.join(fixture, 'node_modules'));
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, 'node'));
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ private: true, type: 'module', workspaces: ['packages/*'] }),
  );
  writeFileSync(path.join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ name: 'config-perf-app', private: true, type: 'module' }),
  );
  writeFileSync(path.join(fixture, '.gitignore'), 'node_modules\nvite.config.ts\n');
  for (const [i, file] of files.entries()) {
    writeFileSync(path.join(fixture, file), `export const f${i} = ${i};\n`);
  }
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  for (const variant of variants) {
    variant.root = path.join(temporary, variant.label);
    mkdirSync(path.join(variant.root, 'binding'), { recursive: true });
    for (const file of ['bin', 'dist', 'package.json']) {
      cpSync(path.join(cliPackage, file), path.join(variant.root, file), { recursive: true });
    }
    for (const file of ['index.js', 'index.cjs']) {
      cpSync(path.join(cliPackage, 'binding', file), path.join(variant.root, 'binding', file));
    }
    // Only this CLI's loader changes. A global NAPI override would also affect Oxc.
    const loader = path.join(variant.root, 'binding/index.cjs');
    let code = readFileSync(loader, 'utf8');
    const needle = 'function requireNative() {';
    if (!code.includes(needle)) {
      throw new Error('Unrecognized NAPI loader');
    }
    code = code.replace(needle, `${needle}\n return require(${JSON.stringify(variant.binding)});`);
    writeFileSync(loader, code);
    symlinkSync(
      path.join(cliPackage, 'node_modules'),
      path.join(variant.root, 'node_modules'),
      'dir',
    );
  }
  for (let round = 0; round < warmup + samples; round++) {
    for (let offset = 0; offset < cases.length; offset++) {
      const item = cases[(round + offset) % cases.length];
      for (let v = 0; v < variants.length; v++) {
        const variant = variants[(round + offset + v) % variants.length];
        for (const [link, target] of [
          [path.join(fixture, 'node_modules/vite-plus'), variant.root],
          [path.join(bin, 'vp'), path.join(variant.root, 'bin/vp')],
        ]) {
          rmSync(link, { force: true });
          symlinkSync(target, link);
        }
        const configPath = path.join(fixture, 'vite.config.ts');
        rmSync(configPath, { force: true });
        if (configs[item.config] !== undefined) {
          writeFileSync(configPath, configs[item.config]);
        }
        for (const [i, file] of files.entries()) {
          writeFileSync(
            path.join(fixture, file),
            `export const f${i}={message:"fixture",value:${i}}\n`,
          );
        }
        if (item.command === 'staged') {
          git('add', '--', ...files);
        }
        const args = ['-p', process.execPath, path.join(variant.root, 'bin/vp'), item.command];
        if (item.command === 'check' || item.command === 'lint') {
          args.push('--fix');
        }
        if (item.command !== 'staged') {
          args.push(
            ...files.map((file) => (item.package ? path.relative('packages/app', file) : file)),
          );
        }
        const measured = run('/usr/bin/time', args, item.package ? app : fixture, {
          NODE_COMPILE_CACHE: path.join(temporary, `${variant.label}-compile-cache`),
        });
        const times = Object.fromEntries(
          ['real', 'user', 'sys'].map((key) => {
            const value = measured.stderr.match(
              new RegExp(`^${key}\\s+(\\d+(?:\\.\\d+)?)$`, 'm'),
            )?.[1];
            if (!value) {
              throw new Error(`Missing ${key}: ${measured.stderr}`);
            }
            return [key, Number(value)];
          }),
        );
        if (item.command !== 'lint' && item.config !== 'noop') {
          for (const file of files) {
            const formatted =
              item.command === 'staged'
                ? git('show', `:${file}`)
                : readFileSync(path.join(fixture, file), 'utf8');
            if (!formatted.includes('= {')) {
              throw new Error(`${item.id}/${variant.label} did not format ${file}`);
            }
          }
        }
        if (round >= warmup) {
          report.measurements.push({
            case: item.id,
            variant: variant.label,
            round: round - warmup,
            order: v,
            elapsed: measured.elapsed,
            real: times.real,
            user: times.user,
            sys: times.sys,
          });
        }
      }
    }
    process.stdout.write(`Completed native diagnostic round ${round + 1}/${warmup + samples}\n`);
  }
} finally {
  report.telemetryAfter = telemetry();
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  rmSync(temporary, { recursive: true, force: true });
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = cases.map((item) => {
  const times = Object.fromEntries(
    variants.map((v) => [
      v.label,
      median(
        report.measurements
          .filter((m) => m.case === item.id && m.variant === v.label)
          .map((m) => m.elapsed),
      ),
    ]),
  );
  const cpu = Object.fromEntries(
    variants.map((v) => [
      v.label,
      median(
        report.measurements
          .filter((m) => m.case === item.id && m.variant === v.label)
          .map((m) => m.user + m.sys),
      ),
    ]),
  );
  return {
    case: item.id,
    before: times.before,
    after: times.after,
    control: times.control,
    change: (times.after / times.before - 1) * 100,
    controlChange: (times.control / times.after - 1) * 100,
    cpu,
  };
});
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(rows, null, 2) + '\n');
const markdown = [
  '## Same-runner native diagnostic',
  '',
  `Linux CI uses release binaries; ${samples} samples and ${warmup} warmups per version/case. Cases and version order rotate. JavaScript, dependencies and fixture content are identical. Each version has its own warm compile cache. The control loads the exact same binary as after.`,
  '',
  '| Case | Before (ms) | After (ms) | Change | Identical binary control change | CPU before → after (s) |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (r) =>
      `| ${r.case} | ${r.before.toFixed(1)} | ${r.after.toFixed(1)} | ${r.change.toFixed(1)}% | ${r.controlChange.toFixed(1)}% | ${r.cpu.before.toFixed(2)} → ${r.cpu.after.toFixed(2)} |`,
  ),
  '',
].join('\n');
writeFileSync(path.join(output, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
process.stdout.write(markdown);
