import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  applyEdits, decodeTextBuffer, findSimilarTitles, formatX10, hasUnread, isCaughtUp,
  isFinishedReading, markChecked,
  parseNewCsv, parseX10, stepProgress, todayLocal, unreadX10,
  worksFromJson, worksToCsv, worksToJson,
  type Work,
} from './core';
import {
  applyImport, clearAllData, loadOrderedWorks, planImport, removeWork, restoreWork,
  saveNewWork, updateWork, type ImportPlan,
} from './db';
import {
  clearCloudSyncState, formatCloudDateTime,
  getActiveCloudProviderId, getCloudLastSyncedAt, getCloudRemoteUpdatedAt,
  setActiveCloudProviderId, setCloudLastSyncedAt, setCloudRemoteUpdatedAt,
  type CloudProvider, type CloudRemoteMeta,
} from './cloud';
import { googleDriveProvider } from './cloud-google-drive';

// 利用できるクラウド同期先の一覧。同期を有効にできるのは常に1つだけ。
// 別のクラウドを足すときは、ここに実装を追加する。
const CLOUD_PROVIDERS: CloudProvider[] = [googleDriveProvider];

const CATEGORIES = ['アニメ', '漫画', '映画', 'ドラマ', '小説', '書籍', 'ゲーム', '音楽', 'その他'];
const UNITS = ['話', '巻', '冊', '章', 'ページ', '本', '曲', '期', 'ステージ', '時間', '分', '%', 'その他'];
const PREVIEW_ROWS = 100;

interface Loaded {
  works: Work[];
  sourceName: string;
  format: 'new' | 'json';
}

interface Toast {
  message: string;
  work: Work; // 操作前の状態（元に戻す用）
  index: number;
  deleted: false | boolean;
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function statsOf(w: Work[]) {
  const c = (pred: (x: Work) => boolean) => w.filter(pred).length;
  return {
    total: w.length,
    favorite: c(x => x.favorite),
    completed: c(x => x.isCompleted),
    hidden: c(x => x.isHidden),
    adult: c(x => x.hasAdult),
    withDate: c(x => x.lastCheckedDate !== null),
    decimal: c(x => (x.progressX10 ?? 0) % 10 !== 0 || (x.maxX10 ?? 0) % 10 !== 0),
  };
}

// ---------- 作品カード（一覧の項目） ----------

interface WorkCardProps {
  work: Work;
  onStep: (w: Work, deltaX10: number) => void;
  onCheck: (w: Work) => void;
  onEdit: (w: Work) => void;
  onDelete: (w: Work) => void;
}

function WorkCard({ work: w, onStep, onCheck, onEdit, onDelete }: WorkCardProps) {
  const remain = unreadX10(w);
  const pct = w.maxX10 !== null && w.maxX10 > 0
    ? Math.min(100, Math.round(((w.progressX10 ?? 0) / w.maxX10) * 100))
    : null;
  return (
    <article className={`workCard${w.isHidden ? ' isHidden' : ''}`}>
      <div className="cardHead">
        <h3 className="cardTitle">{w.title}</h3>
        {w.favorite && <span className="star" aria-label="お気に入り">★</span>}
      </div>
      <div className="chipRow">
        <span className="chip">{w.category}</span>
        {w.isCompleted && <span className="badge badgeDone">完結</span>}
        {w.hasAdult && <span className="badge badgeAdult">アダルト</span>}
        {w.isHidden && <span className="badge badgeHidden">非表示</span>}
      </div>
      <div className="progressLine">
        <span className="progressNow">{formatX10(w.progressX10)}</span>
        <span className="progressSep">/</span>
        <span className="progressMax">{w.maxX10 === null ? '—' : formatX10(w.maxX10)}</span>
        <span className="unitLabel">{w.unit}</span>
        {remain !== null && remain > 0 && <span className="remain">残り {formatX10(remain)}</span>}
        {remain === 0 && w.maxX10 !== null && <span className="remain caughtUp">最新まで追いつき</span>}
      </div>
      {pct !== null && (
        <div className="progressBar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="progressFill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="stepper">
        <button onClick={() => onStep(w, -10)} aria-label="進捗を1減らす">−1</button>
        <button onClick={() => onStep(w, -1)} aria-label="進捗を0.1減らす">−0.1</button>
        <button onClick={() => onStep(w, 1)} aria-label="進捗を0.1増やす">+0.1</button>
        <button onClick={() => onStep(w, 10)} aria-label="進捗を1増やす">+1</button>
      </div>
      {w.memo && <p className="memo">{w.memo}</p>}
      <div className="cardFoot">
        <span className="dates">
          <span>チェック {w.lastCheckedDate ?? '—'}</span>
          <span>進捗 {w.lastProgressDate ?? '—'}</span>
        </span>
        <span className="cardActions">
          <button className="ghostBtn" onClick={() => onCheck(w)}>確認</button>
          <button className="ghostBtn" onClick={() => onEdit(w)}>編集</button>
          <button className="ghostBtn danger" onClick={() => onDelete(w)}>削除</button>
        </span>
      </div>
    </article>
  );
}

// ---------- 汎用モーダル ----------
// すべてのダイアログはこの外枠を共有する: 背景クリックか Esc で閉じ、
// ダイアログが重なっているときは最前面のものだけが Esc に応じる
// （例: 設定ダイアログの上に重なる削除確認）。
// 開いている間は背後のページのスクロールを止める（最初の1つが開いた
// 時点で止め、すべて閉じた時点で元の状態に戻す）。

const modalStack: object[] = [];
let savedBodyOverflow: string | null = null;

function Modal({ title, onClose, wide, children }: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const idRef = useRef<object | null>(null);
  if (idRef.current === null) idRef.current = {};
  useEffect(() => {
    const id = idRef.current!;
    modalStack.push(id);
    if (modalStack.length === 1) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === id) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      if (modalStack.length === 0) {
        document.body.style.overflow = savedBodyOverflow ?? '';
        savedBodyOverflow = null;
      }
    };
  }, [onClose]);
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className={`modal${wide ? ' settingsModal' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="modalHead">
          <h3 className="modalTitle">{title}</h3>
          <button className="modalClose" onClick={onClose} aria-label="閉じる">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirmMessage">{message}</p>
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnDanger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ---------- 編集フォーム（モーダル） ----------

interface EditFormProps {
  initial: Work;
  isNew: boolean;
  existingWorks: Work[];
  onSave: (draft: Work) => void;
  onCancel: () => void;
}

function EditForm({ initial, isNew, existingWorks, onSave, onCancel }: EditFormProps) {
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState(initial.category);
  const [unit, setUnit] = useState(initial.unit);
  const [progressText, setProgressText] = useState(formatX10(initial.progressX10));
  const [maxText, setMaxText] = useState(formatX10(initial.maxX10));
  const [favorite, setFavorite] = useState(initial.favorite);
  const [isCompleted, setIsCompleted] = useState(initial.isCompleted);
  const [hasAdult, setHasAdult] = useState(initial.hasAdult);
  const [isHidden, setIsHidden] = useState(initial.isHidden);
  const [checkedDate, setCheckedDate] = useState(initial.lastCheckedDate ?? '');
  const [progressDate, setProgressDate] = useState(initial.lastProgressDate ?? '');
  const [memo, setMemo] = useState(initial.memo);
  const [formError, setFormError] = useState<string | null>(null);
  // 新規登録のときだけ、似たタイトルの既存作品を知らせる（登録自体は妨げない）。
  const similar = useMemo(
    () => (isNew ? findSimilarTitles(existingWorks, title) : []),
    [isNew, existingWorks, title],
  );

  function submit() {
    if (title.trim() === '') { setFormError('タイトルを入力してください'); return; }
    try {
      onSave({
        id: initial.id,
        title,
        category, unit,
        progressX10: parseX10(progressText) ?? 0,
        maxX10: parseX10(maxText), // 空欄は未確認（null）
        favorite, isCompleted, hasAdult, isHidden,
        lastCheckedDate: checkedDate === '' ? null : checkedDate,
        lastProgressDate: progressDate === '' ? null : progressDate,
        memo,
      });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal title={isNew ? '新規登録' : '編集'} onClose={onCancel}>
      <div className="formGrid">
        <label className="wide">タイトル <input type="text" value={title} onChange={e => setTitle(e.target.value)} /></label>
        {similar.length > 0 && (
          <p className="note wide">似たタイトルが登録済みです: {similar.map(w => `「${w.title}」（${w.category}）`).join('、')}。別の作品であれば、そのまま登録できます。</p>
        )}
        <label>カテゴリ
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {!CATEGORIES.includes(category) && <option>{category}</option>}
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>進捗単位
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            {!UNITS.includes(unit) && <option>{unit}</option>}
            {UNITS.map(u => <option key={u}>{u}</option>)}
          </select>
        </label>
        <label>進捗 <input type="text" inputMode="decimal" value={progressText} onChange={e => setProgressText(e.target.value)} placeholder="例: 11.1" /></label>
        <label>最大 <input type="text" inputMode="decimal" value={maxText} onChange={e => setMaxText(e.target.value)} placeholder="空欄 = 未確認" /></label>
        <label>最終チェック日 <input type="date" value={checkedDate} onChange={e => setCheckedDate(e.target.value)} /></label>
        <label>最終進捗日 <input type="date" value={progressDate} onChange={e => setProgressDate(e.target.value)} /></label>
        <label className="wide">メモ <input type="text" value={memo} onChange={e => setMemo(e.target.value)} /></label>
      </div>
      <div className="flagRow">
        <label><input type="checkbox" checked={favorite} onChange={e => setFavorite(e.target.checked)} /> お気に入り</label>
        <label><input type="checkbox" checked={isCompleted} onChange={e => setIsCompleted(e.target.checked)} /> 完結</label>
        <label><input type="checkbox" checked={hasAdult} onChange={e => setHasAdult(e.target.checked)} /> アダルト</label>
        <label><input type="checkbox" checked={isHidden} onChange={e => setIsHidden(e.target.checked)} /> 非表示</label>
      </div>
      <p className="note">進捗を変えると最終進捗日、最大を変えると最終チェック日が自動で今日になります（日付を自分で変えた場合はそちら優先）。</p>
      {formError && <p className="error" role="alert">{formError}</p>}
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnPrimary" onClick={submit}>保存する</button>
      </div>
    </Modal>
  );
}

// ---------- メイン画面 ----------

// ---------- 確認日ダイアログ ----------

function CheckDialog({ work, onConfirm, onCancel }: {
  work: Work;
  onConfirm: (date: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(todayLocal());
  return (
    <Modal title="確認日を設定" onClose={onCancel}>
      <p className="checkTarget">「{work.title}」の最終チェック日を記録します。</p>
      <label className="checkDateLabel">最終チェック日
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
      </label>
      <p className="note">日付を選んでOKするとその日が入ります。空欄のままOKすると今日になります。</p>
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnPrimary" onClick={() => onConfirm(date === '' ? todayLocal() : date)}>OK</button>
      </div>
    </Modal>
  );
}

export default function App() {
  // 設定は localStorage に置く（端末ローカル。作品データには混ぜない）。
  const [category, setCategory] = useState(() => localStorage.getItem('season-log:defaultCategory') ?? '漫画');
  const [unit, setUnit] = useState(() => localStorage.getItem('season-log:defaultUnit') ?? '話');
  useEffect(() => { localStorage.setItem('season-log:defaultCategory', category); }, [category]);
  useEffect(() => { localStorage.setItem('season-log:defaultUnit', unit); }, [unit]);

  const stored = useLiveQuery(() => loadOrderedWorks(), [], [] as Work[]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [query, setQuery] = useState('');
  type FlagMode = 'any' | 'only' | 'exclude';
  const [flagFilters, setFlagFilters] = useState<Record<'favorite' | 'completed' | 'adult' | 'hidden', FlagMode>>({
    favorite: 'any', completed: 'any', adult: 'any', hidden: 'exclude',
  });
  const [viewKey, setViewKey] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortKey, setSortKey] = useState('orderDesc');
  type ThemePref = 'light' | 'system' | 'dark';
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    const v = localStorage.getItem('season-log:theme');
    // 'auto' はテーマ導入初版で使った値で、'system' と同じ意味として読み替える。
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  useEffect(() => {
    localStorage.setItem('season-log:theme', themePref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const effective =
        themePref === 'system' ? (mq.matches ? 'dark' : 'light') : themePref;
      document.documentElement.dataset.theme = effective;
      // ステータスバーの色（theme-color）も、実効テーマの背景色に合わせる。
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', effective === 'dark' ? '#0F1F1E' : '#FAFAF9');
    };
    apply();
    if (themePref !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themePref]);
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; original: Work } | null>(null);
  const [checking, setChecking] = useState<Work | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // クラウド同期（手動のみ）: 有効なプロバイダは常に1つだけ。
  const [cloudProviderId, setCloudProviderId] = useState(() => getActiveCloudProviderId());
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState<string | null>(null);
  const [cloudLastSynced, setCloudLastSynced] = useState(() => getCloudLastSyncedAt());
  const [cloudRemoteMeta, setCloudRemoteMeta] = useState<CloudRemoteMeta | null>(null);
  const [confirmingCloudOverwrite, setConfirmingCloudOverwrite] = useState(false);
  // クラウドから読み込んだ取り込み待ちデータの出所（保存時に同期記録を更新するため）。
  const [loadedFromCloud, setLoadedFromCloud] = useState<CloudRemoteMeta | null>(null);
  const activeCloudProvider = CLOUD_PROVIDERS.find(p => p.id === cloudProviderId) ?? null;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // 「先頭へ戻る」ボタンの表示: 一定量スクロールしたら出す
  const [showToTop, setShowToTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowToTop(window.scrollY > 600);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // バージョン表示: sw.js の CACHE_NAME（season-log-YYYY.MM-rN）から取り出す
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/sw.js', { cache: 'no-store' })
      .then(res => (res.ok ? res.text() : ''))
      .then(text => {
        const m = text.match(/season-log-(\d{4}\.\d{2}-r\d+)/);
        if (!cancelled && m) setAppVersion(m[1]);
      })
      .catch(() => { /* 取得できない環境では表示しない */ });
    return () => { cancelled = true; };
  }, []);

  const storedStats = useMemo(() => statsOf(stored), [stored]);
  const loadedStats = useMemo(() => (loaded ? statsOf(loaded.works) : null), [loaded]);
  const categoryOptions = useMemo(() => {
    const seen: string[] = [];
    for (const w of stored) if (!seen.includes(w.category)) seen.push(w.category);
    return seen;
  }, [stored]);

  const visible = useMemo(() => {
    const views: Record<string, (w: Work) => boolean> = {
      all: () => true,
      check: w => !w.isCompleted,
      unread: hasUnread,
      caughtup: isCaughtUp,
      finished: isFinishedReading,
    };
    const flagValue: Record<string, (w: Work) => boolean> = {
      favorite: w => w.favorite,
      completed: w => w.isCompleted,
      adult: w => w.hasAdult,
      hidden: w => w.isHidden,
    };
    const flagOk = (w: Work) => (Object.keys(flagFilters) as (keyof typeof flagFilters)[]).every(k => {
      const mode = flagFilters[k];
      return mode === 'any' || (mode === 'only') === flagValue[k](w);
    });
    const q = query.trim().toLowerCase();
    const list = stored.filter(w =>
      flagOk(w) &&
      (views[viewKey] ?? views.all)(w) &&
      (categoryFilter === 'all' || w.category === categoryFilter) &&
      (q === '' || w.title.toLowerCase().includes(q) || w.memo.toLowerCase().includes(q)),
    );
    const sorted = [...list];
    // 並び替え: どのキーでも両方向を選べる。同点の場合は保存順を保つ（安定ソート）。
    // 日付なしは「最も古い」扱いにする（新しい順では末尾、古い順では先頭）。
    // 残りは、最大が未確認で計算できない作品を、多い順・少ない順のどちらでも末尾に置く。
    const byDate = (get: (w: Work) => string | null, dir: 1 | -1) =>
      (a: Work, b: Work) => dir * (get(a) ?? '').localeCompare(get(b) ?? '');
    const byUnread = (dir: 1 | -1) => (a: Work, b: Work) => {
      const ua = unreadX10(a);
      const ub = unreadX10(b);
      if (ua === null && ub === null) return 0;
      if (ua === null) return 1;
      if (ub === null) return -1;
      return dir * (ua - ub);
    };
    switch (sortKey) {
      case 'orderDesc': sorted.reverse(); break;
      case 'titleAsc': sorted.sort((a, b) => a.title.localeCompare(b.title, 'ja')); break;
      case 'titleDesc': sorted.sort((a, b) => b.title.localeCompare(a.title, 'ja')); break;
      case 'unreadDesc': sorted.sort(byUnread(-1)); break;
      case 'unreadAsc': sorted.sort(byUnread(1)); break;
      case 'progressDesc': sorted.sort(byDate(w => w.lastProgressDate, -1)); break;
      case 'progressAsc': sorted.sort(byDate(w => w.lastProgressDate, 1)); break;
      case 'checkAsc': sorted.sort(byDate(w => w.lastCheckedDate, 1)); break;
      case 'checkDesc': sorted.sort(byDate(w => w.lastCheckedDate, -1)); break;
      default: break; // orderAsc は保存順のまま
    }
    return sorted;
  }, [stored, flagFilters, viewKey, categoryFilter, query, sortKey]);

  // 絞り込みが既定以外になっているか（検索ボタンのドット表示と、リセットの可否に使う）
  const filtersActive =
    query.trim() !== '' || viewKey !== 'all' || categoryFilter !== 'all' || sortKey !== 'orderDesc' ||
    flagFilters.favorite !== 'any' || flagFilters.completed !== 'any' ||
    flagFilters.adult !== 'any' || flagFilters.hidden !== 'exclude';

  function resetFilters() {
    setQuery('');
    setViewKey('all');
    setCategoryFilter('all');
    setSortKey('orderDesc');
    setFlagFilters({
      favorite: 'any',
      completed: 'any',
      adult: 'any',
      hidden: 'exclude',
    });
  }

  // 一覧の先頭へ滑らかに戻る
  function scrollToTop() {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }

  // 検索モーダルの「結果を表示」: 閉じて一覧の先頭へ戻る
  function showSearchResults() {
    setShowSearch(false);
    scrollToTop();
  }

  async function onFile(file: File) {
    setError(null);
    setSavedNote(null);
    setLoadedFromCloud(null);
    try {
      const text = decodeTextBuffer(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith('.json')) {
        setLoaded({ works: worksFromJson(text), sourceName: file.name, format: 'json' });
      } else {
        setLoaded({ works: parseNewCsv(text), sourceName: file.name, format: 'new' });
      }
    } catch (e) {
      setLoaded(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveImport(mode: 'merge' | 'replace') {
    if (!loaded) return;
    const plan: ImportPlan = planImport(stored, loaded.works, mode);
    await applyImport(plan, mode);
    setSavedNote(
      mode === 'replace'
        ? `保存しました: 全${plan.added}件を入れ替えました`
        : `保存しました: 追加 ${plan.added}件 / 更新 ${plan.updated}件 / 変更なし ${plan.unchanged}件`,
    );
    if (loadedFromCloud) {
      // クラウドから読み込んだ分は、その時点のクラウドの状態を把握済みとして記録する。
      const now = new Date().toISOString();
      setCloudRemoteUpdatedAt(loadedFromCloud.updatedAt);
      setCloudLastSyncedAt(now);
      setCloudLastSynced(now);
      setCloudRemoteMeta(loadedFromCloud);
      setLoadedFromCloud(null);
      setCloudNote('クラウドから読み込みました。');
    }
    setLoaded(null);
  }

  // ----- クラウド同期（手動のみ。自動同期はしない） -----

  async function handleCloudConnect(provider: CloudProvider) {
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('接続しています…');
    try {
      await provider.connect();
      setActiveCloudProviderId(provider.id);
      setCloudProviderId(provider.id);
      setCloudConnected(true);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      setCloudNote(meta
        ? `${provider.label}に接続しました。クラウドには ${formatCloudDateTime(meta.updatedAt)} 更新の同期ファイルがあります。`
        : `${provider.label}に接続しました。クラウドにはまだ同期ファイルがありません。`);
    } catch (e) {
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  function handleCloudDisconnect() {
    if (!activeCloudProvider) return;
    activeCloudProvider.disconnect();
    clearCloudSyncState();
    setCloudProviderId(null);
    setCloudConnected(false);
    setCloudRemoteMeta(null);
    setCloudLastSynced(null);
    setLoadedFromCloud(null);
    setCloudError(null);
    setCloudNote('クラウド同期の接続を解除しました。クラウド上のファイルは消えていません。');
  }

  // 保存・読み込み・コピーの共通前処理: 接続が切れていたら繋ぎ直す。
  async function ensureCloudConnected(provider: CloudProvider): Promise<void> {
    if (!provider.isConnected()) await provider.connect();
    setCloudConnected(true);
  }

  async function handleCloudSave(force: boolean) {
    const provider = activeCloudProvider;
    if (!provider) return;
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('クラウドを確認しています…');
    try {
      await ensureCloudConnected(provider);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      if (!force && meta && meta.updatedAt !== getCloudRemoteUpdatedAt()) {
        // この端末が把握している版とクラウドの実物が違う＝他の端末で
        // 更新された可能性があるため、上書き前に確認する。
        setConfirmingCloudOverwrite(true);
        return;
      }
      setCloudBusy('クラウドに保存しています…');
      const saved = await provider.uploadSyncFile(worksToJson(stored), meta);
      const now = new Date().toISOString();
      setCloudRemoteUpdatedAt(saved.updatedAt);
      setCloudLastSyncedAt(now);
      setCloudLastSynced(now);
      setCloudRemoteMeta(saved);
      setCloudNote(`${provider.label}に保存しました（${formatCloudDateTime(saved.updatedAt)}）。`);
    } catch (e) {
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  async function handleCloudLoad() {
    const provider = activeCloudProvider;
    if (!provider) return;
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('クラウドから読み込んでいます…');
    try {
      await ensureCloudConnected(provider);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      if (!meta) {
        setCloudError('クラウドにはまだ同期ファイルがありません。先に「クラウドに保存」を実行してください。');
        return;
      }
      const text = await provider.downloadSyncFile(meta.id);
      setLoaded({ works: worksFromJson(text), sourceName: `${provider.label} の同期ファイル`, format: 'json' });
      setLoadedFromCloud(meta);
      setCloudNote('クラウドの内容を取り込み待ちにしました。下の確認欄で保存方法を選んでください。');
    } catch (e) {
      setLoadedFromCloud(null);
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  async function confirmClearAll() {
    setConfirmingClear(false);
    setShowSettings(false);
    await clearAllData();
    setSavedNote('保存済みデータをすべて削除しました');
  }

  // ----- ライブラリ操作（いずれも取り消し用スナップショットを保持し、確認ダイアログは出さない） -----

  function indexOf(w: Work) {
    return stored.findIndex(x => x.id === w.id);
  }

  async function onStep(w: Work, deltaX10: number) {
    const next = stepProgress(w, deltaX10, todayLocal());
    if (next === w) return;
    await updateWork(next);
    setToast({
      message: `「${w.title}」の進捗を ${formatX10(w.progressX10)} → ${formatX10(next.progressX10)} に変更しました`,
      work: w, index: indexOf(w), deleted: false,
    });
  }

  async function confirmCheck(dateStr: string) {
    const w = checking;
    setChecking(null);
    if (!w) return;
    const next = markChecked(w, dateStr);
    if (next === w) return;
    await updateWork(next);
    setToast({
      message: `「${w.title}」を確認済みにしました（最終チェック日 = ${dateStr}）`,
      work: w, index: indexOf(w), deleted: false,
    });
  }

  async function onDelete(w: Work) {
    const idx = indexOf(w);
    await removeWork(w.id);
    setToast({ message: `「${w.title}」を削除しました`, work: w, index: idx, deleted: true });
  }

  async function onUndo() {
    if (!toast) return;
    if (toast.deleted) await restoreWork(toast.work, toast.index);
    else await updateWork(toast.work);
    setToast(null);
  }

  async function handleFormSave(draft: Work) {
    const today = todayLocal();
    if (editing?.mode === 'edit') {
      await updateWork(applyEdits(editing.original, draft, today));
    } else {
      let w: Work = { ...draft, id: crypto.randomUUID() };
      if ((w.progressX10 ?? 0) > 0 && w.lastProgressDate === null) w = { ...w, lastProgressDate: today };
      // 空欄の最終チェック日は進捗日で埋める（他経路と同じ補完ルール）。
      if (w.lastCheckedDate === null && w.lastProgressDate !== null) w = { ...w, lastCheckedDate: w.lastProgressDate };
      await saveNewWork(w);
    }
    setEditing(null);
  }

  function blankWork(): Work {
    return {
      id: '', title: '', category, unit,
      progressX10: 0, maxX10: null,
      favorite: false, isCompleted: false, isHidden: false, hasAdult: false,
      lastCheckedDate: null, lastProgressDate: null, memo: '',
    };
  }

  // 件数サマリ: ページ上と検索モーダルで同じ部品を使う（狭い画面ではページ上は隠し、モーダル内だけに出す）
  const summaryLine = (
    <section className="summary" aria-label="概要">
      <span>全 {storedStats.total} 件</span>
      <span>★ {storedStats.favorite}</span>
      <span>完結 {storedStats.completed}</span>
      <span>アダルト {storedStats.adult}</span>
      <span>非表示 {storedStats.hidden}</span>
    </section>
  );

  // 検索ボックスと絞り込み一式: ページ上（PC）と検索モーダル（狭い画面）で同じ部品を使う
  const filterControls = (
    <>
      <input
        type="search"
        className="searchBox"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="タイトル・メモで検索"
      />
      <div className="filterRow">
        <label>表示
          <select value={viewKey} onChange={e => setViewKey(e.target.value)}>
            <option value="all">すべて</option>
            <option value="check">要チェック（未完結）</option>
            <option value="unread">残りあり</option>
            <option value="caughtup">追いつき</option>
            <option value="finished">完了（完結・残りなし）</option>
          </select>
        </label>
        <label>カテゴリ
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="all">すべて</option>
            {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>並び順
          <select value={sortKey} onChange={e => setSortKey(e.target.value)}>
            <option value="orderDesc">保存順（新しい順）</option>
            <option value="orderAsc">保存順（古い順）</option>
            <option value="titleAsc">タイトル順</option>
            <option value="titleDesc">タイトル逆順</option>
            <option value="unreadDesc">残りが多い順</option>
            <option value="unreadAsc">残りが少ない順</option>
            <option value="progressDesc">最終進捗日が新しい順</option>
            <option value="progressAsc">最終進捗日が古い順</option>
            <option value="checkAsc">最終チェック日が古い順</option>
            <option value="checkDesc">最終チェック日が新しい順</option>
          </select>
        </label>
        {([['favorite', 'お気に入り'], ['completed', '完結'], ['adult', 'アダルト'], ['hidden', '非表示']] as const).map(([key, label]) => (
          <label key={key}>{label}
            <select
              value={flagFilters[key]}
              onChange={e => setFlagFilters(f => ({ ...f, [key]: e.target.value as FlagMode }))}
            >
              <option value="any">指定なし</option>
              <option value="only">のみ表示</option>
              <option value="exclude">非表示</option>
            </select>
          </label>
        ))}
      </div>
    </>
  );

  return (
    <div className="app">
      <header className="appHeader">
        <div className="brand">
          <img className="brandLogo" src="/season-log-icon.svg" alt="" />
          <div>
            <h1>Season Log</h1>
            <p className="tagline">進めかけも、完結も。コンテンツの進捗を記録する</p>
          </div>
        </div>
        <div className="headerActions">
          <button className="btn btnPrimary addBtn" onClick={() => setEditing({ mode: 'new' })}>＋ 新規登録</button>
          <button className="settingsBtn" onClick={() => setShowSettings(true)} aria-label="設定を開く" title="設定">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
        </div>
      </header>
      {showToTop && (
        <button className="toTopBtn" onClick={() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        }} aria-label="先頭へ戻る" title="先頭へ戻る">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
        </button>
      )}
      <button className="fabAdd" onClick={() => setEditing({ mode: 'new' })} aria-label="新規登録" title="新規登録">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <button className={`searchFab${filtersActive ? ' hasActive' : ''}`} onClick={() => setShowSearch(true)} aria-label="検索と絞り込みを開く" title="検索と絞り込み">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
      </button>

      {showSettings && (
        <Modal title="設定" wide onClose={() => setShowSettings(false)}>
          <section className="settingsSection">
            <h2 className="settingsSubheading">テーマ</h2>
            <p className="note">アプリの外観切り替え</p>
            <div className="themeToggleGroup" role="radiogroup" aria-label="テーマ">
              <button type="button" className={`themeToggleBtn${themePref === 'light' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'light'} onClick={() => setThemePref('light')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
                <span>ライト</span>
              </button>
              <button type="button" className={`themeToggleBtn${themePref === 'system' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'system'} onClick={() => setThemePref('system')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor"></path></svg>
                <span>システム</span>
              </button>
              <button type="button" className={`themeToggleBtn${themePref === 'dark' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'dark'} onClick={() => setThemePref('dark')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                <span>ダーク</span>
              </button>
            </div>
          </section>
          <div className="settingsSeparator" />
          <section className="settingsSection">
            <h2 className="settingsSubheading">データ管理</h2>
            <h3>ファイルを取り込む</h3>
            <p className="note">本アプリが出力したCSV、またはJSONバックアップを取り込めます。</p>
            <div className="panelRow">
              <label>新規登録の既定カテゴリ
                <select value={category} onChange={e => setCategory(e.target.value)}>
                  {!CATEGORIES.includes(category) && <option>{category}</option>}
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label>新規登録の既定の進捗単位
                <select value={unit} onChange={e => setUnit(e.target.value)}>
                  {!UNITS.includes(unit) && <option>{unit}</option>}
                  {UNITS.map(u => <option key={u}>{u}</option>)}
                </select>
              </label>
              <input
                type="file"
                accept=".csv,.txt,.json"
                onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
              />
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            {loaded && loadedStats && (
              <div className="importBox">
                <p>
                  <strong>取り込み結果: {loaded.sourceName}</strong><br />
                  形式: {loaded.format === 'new' ? 'CSV' : 'JSONバックアップ'} / {loadedStats.total}件<br />
                  お気に入り {loadedStats.favorite} / 完結 {loadedStats.completed} / アダルト {loadedStats.adult} / 非表示 {loadedStats.hidden} / 日付あり {loadedStats.withDate} / 進捗が小数 {loadedStats.decimal}
                </p>
                <div className="panelRow">
                  {stored.length === 0 && (
                    <button className="btn btnPrimary" onClick={() => void saveImport('replace')}>この内容で保存する</button>
                  )}
                  {stored.length > 0 && (
                    <>
                      <button className="btn btnPrimary" onClick={() => void saveImport('merge')}>IDで照合して保存（既存は更新・新規は追加）</button>
                      <button className="btn" onClick={() => void saveImport('replace')}>すべて入れ替えて保存</button>
                    </>
                  )}
                  <button className="btn" onClick={() => { setLoaded(null); if (loadedFromCloud) setCloudNote(null); setLoadedFromCloud(null); }}>保存しない</button>
                </div>
                <ul className="previewList">
                  {loaded.works.slice(0, PREVIEW_ROWS).map(w => (
                    <li key={w.id}><span className="previewTitle">{w.title}</span><span className="previewMeta">{formatX10(w.progressX10)} / {w.maxX10 === null ? '—' : formatX10(w.maxX10)} {w.unit}</span></li>
                  ))}
                </ul>
                {loaded.works.length > PREVIEW_ROWS && <p className="note">…ほか {loaded.works.length - PREVIEW_ROWS} 件（プレビューは先頭{PREVIEW_ROWS}件のみ）</p>}
              </div>
            )}
            <h3>保存済みデータの書き出し・削除</h3>
            <div className="panelRow">
              <button className="btn" onClick={() => download('season-log.csv', worksToCsv(stored), 'text/csv')} disabled={stored.length === 0}>CSVをダウンロード</button>
              <button className="btn" onClick={() => download('season-log.json', worksToJson(stored), 'application/json')} disabled={stored.length === 0}>JSONをダウンロード</button>
              <button className="btn danger" onClick={() => setConfirmingClear(true)} disabled={stored.length === 0}>全データ削除</button>
            </div>
            <p className="note">データはこのブラウザに保存されています（IndexedDB）。バックアップや他の端末への移行には、JSONまたはCSVのダウンロードをご利用ください。</p>
          </section>
          <div className="settingsSeparator" />
          <section className="settingsSection">
            <h2 className="settingsSubheading">クラウド同期</h2>
            {!activeCloudProvider && (
              <>
                <p className="note">JSONバックアップをクラウドに保存して、他の端末と受け渡しできます。同期はボタンを押したときだけ行います（自動同期はしません）。利用できるクラウドは1つだけです。</p>
                <div className="panelRow">
                  {CLOUD_PROVIDERS.map(p => (
                    <button key={p.id} className="btn" disabled={cloudBusy !== null || !p.isConfigured()} onClick={() => void handleCloudConnect(p)}>{p.label}に接続</button>
                  ))}
                </div>
                {CLOUD_PROVIDERS.some(p => !p.isConfigured()) && (
                  <p className="note">未設定のクラウドは利用できません（デプロイ環境の環境変数で、接続に必要なIDを設定してください）。</p>
                )}
              </>
            )}
            {activeCloudProvider && (
              <>
                <p className="note">
                  接続先: {activeCloudProvider.label}（{cloudConnected ? '接続済み' : '未接続 — 操作時に自動で接続します'}）
                  {cloudLastSynced && <><br />最終同期: {formatCloudDateTime(cloudLastSynced)}</>}
                  {cloudRemoteMeta && <><br />クラウドの同期ファイル: {formatCloudDateTime(cloudRemoteMeta.updatedAt)} 更新</>}
                </p>
                <div className="panelRow">
                  <button className="btn btnPrimary" disabled={cloudBusy !== null || stored.length === 0} onClick={() => void handleCloudSave(false)}>クラウドに保存</button>
                  <button className="btn" disabled={cloudBusy !== null} onClick={() => void handleCloudLoad()}>クラウドから読み込む</button>
                  <button className="btn" disabled={cloudBusy !== null} onClick={handleCloudDisconnect}>接続を解除</button>
                </div>
                <p className="note">読み込むと、ファイルの取り込みと同じ確認欄が出て、保存方法（IDで照合／すべて入れ替え）を選べます。接続を解除しても、クラウド上のファイルは消えません。</p>
              </>
            )}
            {cloudBusy && <p className="note" role="status">{cloudBusy}</p>}
            {cloudError && <p className="error" role="alert">{cloudError}</p>}
            {cloudNote && <p className="ok">{cloudNote}</p>}
          </section>
          {appVersion && <p className="versionLine">Ver {appVersion}</p>}
        </Modal>
      )}

      {showSearch && (
        <Modal title="検索と絞り込み" onClose={() => setShowSearch(false)}>
          {filterControls}
          {summaryLine}
          <p className="countLine">全{storedStats.total}件中 {visible.length}件を表示</p>
          <div className="modalActions">
            <button className="btn" onClick={resetFilters} disabled={!filtersActive}>条件をリセット</button>
            <button className="btn btnPrimary" onClick={showSearchResults}>結果を表示</button>
          </div>
        </Modal>
      )}

      {savedNote && <p className="ok banner">{savedNote}</p>}

      {summaryLine}

      <section className="filters" aria-label="検索と絞り込み">
        {filterControls}
      </section>
      <p className="countLine">全{storedStats.total}件中 {visible.length}件を表示</p>

      {stored.length === 0 ? (
        <section className="emptyState">
          <p>まだ作品が登録されていません。</p>
          <p className="note">右上の歯車ボタン（設定）にある「データ管理」から、これまでのデータをCSV / JSONで取り込むか、「＋ 新規登録」から最初の1件を登録してください。</p>
        </section>
      ) : visible.length === 0 ? (
        <section className="emptyState">
          <p>条件に合う作品がありません。</p>
          <p className="note">検索や絞り込みの条件を変えてみてください。</p>
        </section>
      ) : (
        <div className="cardList">
          {visible.map(w => (
            <WorkCard
              key={w.id}
              work={w}
              onStep={(work, d) => void onStep(work, d)}
              onCheck={work => setChecking(work)}
              onEdit={work => setEditing({ mode: 'edit', original: work })}
              onDelete={work => void onDelete(work)}
            />
          ))}
        </div>
      )}
      {flagFilters.hidden === 'exclude' && storedStats.hidden > 0 && (
        <p className="note">非表示の{storedStats.hidden}件は隠れています（絞り込みの「非表示」で切り替えられます）。</p>
      )}

      {editing && (
        <EditForm
          key={editing.mode === 'edit' ? editing.original.id : 'new'}
          initial={editing.mode === 'edit' ? editing.original : blankWork()}
          isNew={editing.mode === 'new'}
          existingWorks={stored}
          onSave={d => void handleFormSave(d)}
          onCancel={() => setEditing(null)}
        />
      )}

      {checking && (
        <CheckDialog
          work={checking}
          onConfirm={d => void confirmCheck(d)}
          onCancel={() => setChecking(null)}
        />
      )}

      {confirmingCloudOverwrite && activeCloudProvider && (
        <ConfirmDialog
          title="クラウド保存の確認"
          message={`クラウド上の同期ファイルは、この端末が最後に把握した状態より新しくなっています（${cloudRemoteMeta ? formatCloudDateTime(cloudRemoteMeta.updatedAt) : ''} 更新）。他の端末で更新された内容が、上書きで消える可能性があります。この端末の内容で上書きしますか？`}
          confirmLabel="上書きして保存する"
          onConfirm={() => { setConfirmingCloudOverwrite(false); void handleCloudSave(true); }}
          onCancel={() => setConfirmingCloudOverwrite(false)}
        />
      )}

      {confirmingClear && (
        <ConfirmDialog
          title="全データ削除"
          message={`保存済みの作品データ（全 ${stored.length} 件）をすべて削除します。この操作は元に戻せません。エクスポートしたCSV/JSONがあれば、そこから復元できます。`}
          confirmLabel="すべて削除する"
          onConfirm={() => void confirmClearAll()}
          onCancel={() => setConfirmingClear(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          <button onClick={() => void onUndo()}>元に戻す</button>
        </div>
      )}
    </div>
  );
}
