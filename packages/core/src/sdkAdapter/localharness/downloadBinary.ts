// localharness 바이너리 자동 다운로드 (C안, Apple Silicon macOS 전용).
// agy 엔진은 PyPI 휠(google-antigravity, zip) 안에만 있다. 휠 1개(30.7MB)를 받아 그 안
// `google/antigravity/bin/localharness`(93MB)만 추출해 ~/.agentbridge/bin/에 캐시한다.
//   - pip·Python 불필요: fetch로 받고 macOS 기본 `unzip -p`로 한 엔트리만 뽑는다.
//   - 바이너리는 ad-hoc 서명(linker-signed)이라 arm64에서 그대로 exec 가능(공증 불필요).
//   - 무결성: 휠 sha256을 핀 값과 대조. 손상/구버전이면 불일치로 재다운로드.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const WHEEL_VERSION = '0.1.4';
const WHEEL_SHA256 = 'cb83022853d1021abffb103dec248cdff92fe0c6d0121f0229616f5524624d01';
const BIN_IN_WHEEL = 'google/antigravity/bin/localharness';
const PYPI_JSON = `https://pypi.org/pypi/google-antigravity/${WHEEL_VERSION}/json`;

export function harnessCachePath(): string {
  return join(homedir(), '.agentbridge', 'bin', 'localharness');
}

function isUsable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).size > 1_000_000; // 부분 추출/0바이트 방어
  } catch {
    return false;
  }
}

export interface ResolveHarnessOpts {
  binaryPath?: string; // 명시 경로(override)
  onProgress?: (received: number, total: number) => void; // 휠 다운로드 진행률
}

let inflight: Promise<string> | null = null; // single-flight: 동시 세션이 같이 받지 않도록

// 경로 해소: override(env/opts) → 캐시 → 다운로드. darwin-arm64 외에서는 다운로드 단계에서 막힌다.
export async function resolveHarnessBinary(opts: ResolveHarnessOpts = {}): Promise<string> {
  const override = opts.binaryPath || process.env.ANTIGRAVITY_HARNESS_PATH;
  if (override && existsSync(override)) return override;
  const cache = harnessCachePath();
  if (isUsable(cache)) return cache;
  if (!inflight) inflight = downloadHarness(opts).finally(() => { inflight = null; });
  return inflight;
}

async function downloadHarness(opts: ResolveHarnessOpts): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('agy 엔진(localharness)은 현재 Apple Silicon macOS(darwin-arm64)에서만 자동 설치됩니다.');
  }
  // 1) PyPI JSON에서 macOS arm64 휠 URL 획득(CDN 경로 하드코딩 회피).
  const meta = (await fetch(PYPI_JSON).then((r) => {
    if (!r.ok) throw new Error(`PyPI 메타 조회 실패: HTTP ${r.status}`);
    return r.json();
  })) as { urls: Array<{ filename: string; url: string }> };
  const wheel = meta.urls.find((u) => u.filename.includes('macosx') && u.filename.includes('arm64'));
  if (!wheel) throw new Error('PyPI에 macOS arm64 휠이 없습니다.');

  // 2) 휠 다운로드 → tmp (스트리밍 + sha256 + 진행률).
  const tmpWheel = join(tmpdir(), `agy-wheel-${WHEEL_VERSION}.whl`);
  const res = await fetch(wheel.url);
  if (!res.ok || !res.body) throw new Error(`휠 다운로드 실패: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const hash = createHash('sha256');
  let received = 0;
  const out = createWriteStream(tmpWheel);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.length;
    opts.onProgress?.(received, total);
    if (!out.write(value)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');

  // 3) 무결성 검증.
  const digest = hash.digest('hex');
  if (digest !== WHEEL_SHA256) {
    rmSync(tmpWheel, { force: true });
    throw new Error(`휠 무결성 불일치(sha256): 기대 ${WHEEL_SHA256.slice(0, 12)}…, 실제 ${digest.slice(0, 12)}…`);
  }

  // 4) localharness 한 엔트리만 추출 → cache.tmp (macOS 기본 unzip -p).
  const cache = harnessCachePath();
  mkdirSync(dirname(cache), { recursive: true });
  const tmpBin = `${cache}.tmp`;
  await extractEntry(tmpWheel, BIN_IN_WHEEL, tmpBin);

  // 5) 실행권한 + quarantine 제거(방어) + 검증 + 원자적 확정.
  spawnSync('chmod', ['0755', tmpBin]);
  spawnSync('xattr', ['-d', 'com.apple.quarantine', tmpBin]); // 없으면 무시(에러 무시)
  if (!isUsable(tmpBin)) {
    rmSync(tmpBin, { force: true });
    throw new Error('추출된 localharness가 실행 불가(크기/권한 확인 실패).');
  }
  renameSync(tmpBin, cache);
  rmSync(tmpWheel, { force: true });
  return cache;
}

function extractEntry(wheelPath: string, entry: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    const uz = spawn('unzip', ['-p', wheelPath, entry]);
    let err = '';
    let code: number | null = null;
    let finished = false;
    const check = (): void => {
      if (!finished || code === null) return;
      if (code === 0) resolve();
      else { rmSync(destPath, { force: true }); reject(new Error(`unzip 실패(code ${code}): ${err.slice(0, 200)}`)); }
    };
    uz.stdout.pipe(out);
    uz.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    uz.on('error', reject);
    uz.on('close', (c) => { code = c ?? 1; check(); });
    out.on('error', reject);
    out.on('finish', () => { finished = true; check(); });
  });
}
