// IndexedDB への保存（Dexie）。
// 表示順は作品オブジェクト自体ではなくメタレコード（作品IDの並び）で保持し、
// バックアップや書き出しがコア形式そのままになるようにする。
import { Dexie, type Table } from 'dexie';
import { diffWorks, normalizeWork, type Work } from './core';

interface MetaRow {
  key: string;
  ids?: string[];
}

class SeasonLogDb extends Dexie {
  works!: Table<Work, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('season-log');
    this.version(1).stores({ works: 'id', meta: 'key' });
  }
}

export const db = new SeasonLogDb();

/** 保存済みの全作品を、保存された表示順で返す（順序にない作品は最後）。
 *  形式 v1 で保存された行（isDropped / 日時）は、読み込み時に移行する。 */
export async function loadOrderedWorks(): Promise<Work[]> {
  const [rawAll, orderRow] = await Promise.all([db.works.toArray(), db.meta.get('order')]);
  const all = rawAll.map(w => normalizeWork(w as unknown as Record<string, unknown>));
  const order = orderRow?.ids ?? [];
  const pos = new Map(order.map((id, i) => [id, i] as const));
  return all.sort(
    (a, b) =>
      (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export interface ImportPlan {
  toPut: Work[];
  order: string[];
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * 取込で何を書くかだけを決める（DBには触れない、純粋でテスト可能な関数）。
 * - replace: incoming の全件がライブラリ全体になる。
 * - merge: IDで照合する（仕様: 既存IDは更新、新規IDは追加、削除はしない）。
 *   内容が同一の行は書き換えない。
 */
export function planImport(
  existing: Work[],
  incoming: Work[],
  mode: 'merge' | 'replace',
): ImportPlan {
  if (mode === 'replace') {
    const toPut = incoming.map(w => ({ ...w }));
    return { toPut, order: toPut.map(w => w.id), added: toPut.length, updated: 0, unchanged: 0 };
  }
  const byId = new Map(existing.map(w => [w.id, w]));
  const toPut: Work[] = [];
  const order = existing.map(w => w.id);
  let added = 0,
    updated = 0,
    unchanged = 0;
  for (const w of incoming) {
    const cur = byId.get(w.id);
    if (!cur) {
      toPut.push({ ...w });
      added++;
      order.push(w.id);
    } else if (diffWorks([cur], [w]).length > 0) {
      toPut.push({ ...w });
      updated++;
    } else {
      unchanged++;
    }
  }
  return { toPut, order, added, updated, unchanged };
}

export async function applyImport(plan: ImportPlan, mode: 'merge' | 'replace'): Promise<void> {
  await db.transaction('rw', db.works, db.meta, async () => {
    if (mode === 'replace') await db.works.clear();
    if (plan.toPut.length > 0) await db.works.bulkPut(plan.toPut);
    await db.meta.put({ key: 'order', ids: plan.order });
  });
}

/** 新しい作品を表示順の末尾に追加する。 */
export async function saveNewWork(work: Work): Promise<void> {
  await db.transaction('rw', db.works, db.meta, async () => {
    await db.works.put(work);
    const orderRow = await db.meta.get('order');
    const ids = orderRow?.ids ?? [];
    if (!ids.includes(work.id)) ids.push(work.id);
    await db.meta.put({ key: 'order', ids });
  });
}

/** 1件を上書きする（表示順は変えない）。 */
export async function updateWork(work: Work): Promise<void> {
  await db.works.put(work);
}

/** 1件を物理削除し、表示順からも落とす。 */
export async function removeWork(id: string): Promise<void> {
  await db.transaction('rw', db.works, db.meta, async () => {
    await db.works.delete(id);
    const orderRow = await db.meta.get('order');
    if (orderRow?.ids) {
      await db.meta.put({ key: 'order', ids: orderRow.ids.filter(x => x !== id) });
    }
  });
}

/** removeWork の取り消し: 作品を元の位置に戻す。 */
export async function restoreWork(work: Work, index: number): Promise<void> {
  await db.transaction('rw', db.works, db.meta, async () => {
    await db.works.put(work);
    const orderRow = await db.meta.get('order');
    const ids = orderRow?.ids ?? [];
    if (!ids.includes(work.id)) ids.splice(Math.max(0, Math.min(index, ids.length)), 0, work.id);
    await db.meta.put({ key: 'order', ids });
  });
}

/** 全件を物理削除する（論理削除の墓標は残さない方針）。 */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.works, db.meta, async () => {
    await db.works.clear();
    await db.meta.clear();
  });
}
