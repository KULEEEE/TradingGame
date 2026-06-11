import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FILE = 'state.json';

export function snapshotPath(root) {
  return path.join(root, FILE);
}

/** 부팅 시 1회만 동기 로드 */
export function loadSnapshot(root) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(root), 'utf8'));
  } catch {
    return null;
  }
}

/** 5초마다 비동기 저장 (tmp에 쓰고 rename — 틱 루프 비블로킹, 파일 깨짐 방지) */
export function startSnapshotLoop(root, game, intervalMs = 5000) {
  let saving = false;
  return setInterval(async () => {
    if (saving) return;
    saving = true;
    try {
      const tmp = snapshotPath(root) + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(game.serialize()));
      await fsp.rename(tmp, snapshotPath(root));
    } catch (e) {
      console.error('[snapshot] 저장 실패:', e.message);
    } finally {
      saving = false;
    }
  }, intervalMs);
}

export async function deleteSnapshot(root) {
  try { await fsp.unlink(snapshotPath(root)); } catch { /* 없으면 무시 */ }
}
